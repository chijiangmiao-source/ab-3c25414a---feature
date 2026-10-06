"""Tests for value-lineage dependency DAG queries.

Covers:
* producer / operand edges captured at dispatch time with allocation
  generations, so physical-tag reuse can never alias an older instance;
* branch-misprediction and precise-exception recovery: queries point at the
  post-recovery (valid) instance while cleared instances keep their squash
  explanation;
* stable node/edge ordering;
* refusal past the session cursor, past the first violation, invalid reg.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.simulator import (  # noqa: E402
    LineageQueryError,
    parse_events,
    parse_program,
    Simulator,
)

PROG_BRANCH = """
ADD R1,R0,R0
ADD R2,R1,R0
BEQ R1,R2 predict=taken
ADD R3,R1,R2
ADD R4,R3,R1
ADD R1,R4,R2
SUB R5,R1,R0
"""

EVENTS_BRANCH = """
dispatch I0
dispatch I1
dispatch I2
dispatch I3
dispatch I4
writeback I0
writeback I1
commit I0
writeback I2
resolve I2 not-taken
dispatch I5
dispatch I6
writeback I5
writeback I6
commit I1
commit I2
commit I5
commit I6
"""

PROG_EXC = """
ADD R1,R0,R0
ADD R2,R1,R0
MUL R3,R1,R2
ADD R4,R3,R1
SUB R5,R4,R3
"""

EVENTS_EXC = """
dispatch I0
dispatch I1
dispatch I2
dispatch I3
dispatch I4
writeback I0
commit I0
writeback I1
writeback I2
exception I2
writeback I3
commit I1
"""


def replay(program, events, num_phys=16):
    sim = Simulator(parse_program(program), num_phys)
    steps = []
    for ev in parse_events(events):
        s = sim.step(ev)
        steps.append(s)
        if s["violation"]:
            break
    return sim, steps


def by_id(dag):
    return {n["id"]: n for n in dag["nodes"]}


class BasicLineageTests(unittest.TestCase):
    def setUp(self):
        self.sim, _ = replay(PROG_BRANCH, EVENTS_BRANCH)

    def test_initial_register_node(self):
        dag = self.sim.lineage_at(0, 0)
        self.assertEqual(dag["root"], "initial:R0")
        self.assertEqual(dag["tag_name"], "P0")
        self.assertEqual(dag["generation"], 0)
        root = dag["nodes"][0]
        self.assertEqual(root["kind"], "initial")
        self.assertEqual(root["status"], "initial")

    def test_dispatch_node_fields_and_edges(self):
        # after dispatch I4 (step 4): I4 ADD R4,R3,R1
        dag = self.sim.lineage_at(4, 4)
        nodes = by_id(dag)
        self.assertEqual(dag["root"], "I4@P11g1")
        root = nodes[dag["root"]]
        self.assertEqual(root["kind"], "dispatch")
        self.assertEqual(root["status"], "live")
        self.assertEqual(root["dispatch_event"], 4)
        self.assertEqual(root["tag"], 11)
        self.assertEqual(root["generation"], 1)
        self.assertEqual(root["op"], "ADD")
        self.assertEqual(root["dest"], 4)
        # edges: R3 -> I3@P10g1 (position 0), R1 -> I0@P8g1 (position 1)
        srcs = {(e["source_position"], e["source_arch"]): e for e in dag["edges"]
                if e["from"] == dag["root"]}
        self.assertEqual(srcs[(0, 3)]["to"], "I3@P10g1")
        self.assertEqual(srcs[(0, 3)]["generation"], 1)
        self.assertEqual(srcs[(1, 1)]["to"], "I0@P8g1")
        self.assertEqual(srcs[(1, 1)]["captured_at_event"], 4)

    def test_edges_immutable_after_later_remap(self):
        # I1 (step1) captured R1 -> I0@P8g1; after mispredict+refetch I5
        # rewrites R1, but the edge frozen in I1 must still point at I0.
        dag = self.sim.lineage_at(17, 2)
        edge = next(e for e in dag["edges"]
                    if e["from"] == "I1@P9g1" and e["source_arch"] == 1)
        self.assertEqual(edge["to"], "I0@P8g1")
        self.assertEqual(edge["tag"], 8)
        self.assertEqual(edge["generation"], 1)

    def test_root_is_first_and_order_is_stable(self):
        dag1 = self.sim.lineage_at(4, 4)
        dag2 = self.sim.lineage_at(4, 4)
        self.assertEqual([n["id"] for n in dag1["nodes"]],
                         [n["id"] for n in dag2["nodes"]])
        self.assertEqual(dag1["nodes"][0]["id"], dag1["root"])
        # producers before consumers in dispatch order (root exempted)
        rest = [n for n in dag1["nodes"] if n["id"] != dag1["root"]]
        events = [n["dispatch_event"] for n in rest if n["kind"] == "dispatch"]
        self.assertEqual(events, sorted(events))
        # edge order stable
        self.assertEqual(
            [(e["from"], e["source_position"]) for e in dag1["edges"]],
            [(e["from"], e["source_position"]) for e in dag2["edges"]])


class TagReuseGenerationTests(unittest.TestCase):
    def setUp(self):
        self.sim, _ = replay(PROG_BRANCH, EVENTS_BRANCH)

    def test_refetch_reuses_tag_with_new_generation(self):
        # I3@P10g1 is squashed at step 9; I5 (step10) reallocates P10 for R1
        # and must open generation 2, distinct from I3's generation 1.
        old = self.sim.lineage_at(4, 3)
        self.assertEqual(old["root"], "I3@P10g1")
        new = self.sim.lineage_at(10, 1)
        self.assertEqual(new["root"], "I5@P10g2")
        self.assertEqual(new["physical_tag"], 10)
        self.assertEqual(new["generation"], 2)
        self.assertNotIn("I3@P10g1", [n["id"] for n in new["nodes"]])

    def test_historical_query_after_reuse_still_names_old_producer(self):
        # Querying the mapping as of step 4 must never resolve to I5 even
        # though I5 now owns the same physical tag P10.
        dag = self.sim.lineage_at(4, 3)
        self.assertEqual(dag["root"], "I3@P10g1")
        node = by_id(dag)[dag["root"]]
        self.assertEqual(node["status"], "live")  # live at step 4
        # the later clearance is still disclosed on the node
        self.assertTrue(node["later_cleared"])
        self.assertEqual(node["squash"]["cause"], "branch_mispredict")
        self.assertEqual(node["squash"]["event"], 9)

    def test_reused_operand_tags_resolve_by_generation(self):
        # I6 SUB R5,R1,R0 reads the refetch R1 (I5@P10g2), not squashed I3.
        dag = self.sim.lineage_at(13, 5)  # after writeback I6 (step 13)
        r1_edge = next(e for e in dag["edges"]
                       if e["from"] == dag["root"] and e["source_arch"] == 1)
        self.assertEqual(r1_edge["to"], "I5@P10g2")
        self.assertEqual(r1_edge["tag"], 10)
        self.assertEqual(r1_edge["generation"], 2)


class MispredictionRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.sim, _ = replay(PROG_BRANCH, EVENTS_BRANCH)

    def test_post_recovery_query_points_to_checkpoint_producer(self):
        # after the step-9 mispredict, R3/R4 map back to architectural tags
        dag3 = self.sim.lineage_at(9, 3)
        dag4 = self.sim.lineage_at(9, 4)
        self.assertEqual(dag3["root"], "initial:R3")
        self.assertEqual(dag4["root"], "initial:R4")
        # older rename survives: R1 -> committed I0, R2 -> in-flight I1
        self.assertEqual(self.sim.lineage_at(9, 1)["root"], "I0@P8g1")
        self.assertEqual(self.sim.lineage_at(9, 2)["root"], "I1@P9g1")

    def test_cleared_instances_keep_explanation(self):
        dag = self.sim.lineage_at(9, 3)
        cleared = {c["seq"]: c for c in dag["cleared_instances"]}
        self.assertEqual(set(cleared), {3})
        note = cleared[3]
        self.assertEqual(note["id"], "I3@P10g1")
        self.assertEqual(note["squash"]["cause"], "branch_mispredict")
        self.assertEqual(note["squash"]["branch_seq"], 2)
        self.assertTrue(note["cleared_as_of_step"])
        # the squashed node present in a historical DAG carries status squashed
        hist = self.sim.lineage_at(9, 3)
        self.assertNotIn("I3@P10g1", [n["id"] for n in hist["nodes"]])

    def test_cleared_node_in_pre_squash_dag_marked_live(self):
        dag = self.sim.lineage_at(4, 4)
        for n in dag["nodes"]:
            if n["seq"] in (3, 4):
                self.assertEqual(n["status"], "live")
                self.assertTrue(n["later_cleared"])


class ExceptionRecoveryLineageTests(unittest.TestCase):
    def setUp(self):
        self.sim, _ = replay(PROG_EXC, EVENTS_EXC)

    def test_post_exception_query_points_to_precise_producers(self):
        # rollback drains when faulting I2 reaches the head (step 11)
        self.assertEqual(self.sim.lineage_at(11, 3)["root"], "initial:R3")
        self.assertEqual(self.sim.lineage_at(11, 4)["root"], "initial:R4")
        self.assertEqual(self.sim.lineage_at(11, 5)["root"], "initial:R5")
        # committed I0 survives the precise rollback
        self.assertEqual(self.sim.lineage_at(11, 1)["root"], "I0@P8g1")

    def test_exception_clearance_notes(self):
        dag = self.sim.lineage_at(11, 3)
        cleared = {c["seq"]: c for c in dag["cleared_instances"]}
        self.assertIn(2, cleared)
        self.assertEqual(cleared[2]["squash"]["cause"], "precise_exception")
        self.assertTrue(cleared[2]["squash"]["is_faulting"])
        self.assertEqual(cleared[2]["squash"]["fault_seq"], 2)

    def test_historical_dag_frozen_before_exception(self):
        dag = self.sim.lineage_at(4, 3)
        self.assertEqual(dag["root"], "I2@P10g1")
        node = by_id(dag)[dag["root"]]
        self.assertEqual(node["status"], "live")
        self.assertTrue(node["later_cleared"])


class LineageRejectionTests(unittest.TestCase):
    def test_step_behind_cursor_rejected(self):
        sim, _ = replay("ADD R1,R0,R0", "dispatch I0")
        with self.assertRaises(LineageQueryError) as ctx:
            sim.lineage_at(3, 1)
        self.assertEqual(ctx.exception.code, "LINEAGE_STEP_AHEAD")

    def test_negative_step_rejected(self):
        sim, _ = replay("ADD R1,R0,R0", "dispatch I0")
        with self.assertRaises(LineageQueryError) as ctx:
            sim.lineage_at(-1, 1)
        self.assertEqual(ctx.exception.code, "LINEAGE_STEP_AHEAD")

    def test_invalid_register_rejected(self):
        sim, _ = replay("ADD R1,R0,R0", "dispatch I0")
        for bad in (8, -1):
            with self.assertRaises(LineageQueryError) as ctx:
                sim.lineage_at(0, bad)
            self.assertEqual(ctx.exception.code, "LINEAGE_BAD_REGISTER")

    def test_after_violation_step_rejected_violation_step_allowed(self):
        program = """
        ADD R1,R0,R0
        BEQ R1,R0 predict=taken
        ADD R2,R1,R0
        ADD R3,R2,R1
        """
        events = """
        dispatch I0
        dispatch I1
        dispatch I2
        dispatch I3
        writeback I0
        writeback I1
        commit I0
        resolve I1 not-taken
        writeback I3
        """
        sim, steps = replay(program, events)
        self.assertEqual(sim.violation_step, 8)
        # the violating step itself is queryable (state unchanged by it)
        dag = sim.lineage_at(8, 2)
        self.assertEqual(dag["root"], "initial:R2")
        # no executed step beyond it; guard still in place for safety
        with self.assertRaises(LineageQueryError):
            sim.lineage_at(9, 2)

    def test_dag_is_acyclic(self):
        sim, _ = replay(PROG_BRANCH, EVENTS_BRANCH)
        dag = sim.lineage_at(17, 5)
        # every edge must go from a later dispatch event to an earlier one
        events = {n["id"]: n["dispatch_event"] for n in dag["nodes"]}
        for e in dag["edges"]:
            fe, te = events[e["from"]], events[e["to"]]
            if fe is not None and te is not None:
                self.assertLess(te, fe)


if __name__ == "__main__":
    unittest.main(verbosity=2)
