import unittest

from main import CONFLICT_CONTEXT, conflict_kinds, conflict_ranges


class ConflictKindsTest(unittest.TestCase):
    def test_diff3_regions(self):
        lines = [
            "a",
            "<<<<<<< ours",
            "mine",
            "||||||| base",
            "orig",
            "=======",
            "theirs",
            ">>>>>>> theirs",
            "z",
        ]
        self.assertEqual(
            conflict_kinds(lines),
            ["ctx", "m-ours", "ours", "m-base", "base", "m-sep", "theirs", "m-theirs", "ctx"],
        )

    def test_markers_outside_a_conflict_are_context(self):
        self.assertEqual(conflict_kinds(["=======", "||||||| x"]), ["ctx", "ctx"])


class ConflictRangesTest(unittest.TestCase):
    def test_context_around_each_conflict(self):
        kinds = ["ctx"] * 20
        kinds[10] = "ours"
        self.assertEqual(
            conflict_ranges(kinds), [[10 - CONFLICT_CONTEXT, 10 + CONFLICT_CONTEXT]]
        )

    def test_clamped_to_the_file(self):
        self.assertEqual(conflict_ranges(["ours", "ctx"]), [[0, 1]])

    def test_overlapping_ranges_are_joined(self):
        kinds = ["ctx"] * 30
        kinds[5] = kinds[5 + 2 * CONFLICT_CONTEXT + 1] = "ours"
        self.assertEqual(conflict_ranges(kinds), [[2, 5 + 3 * CONFLICT_CONTEXT + 1]])

    def test_distant_conflicts_stay_apart(self):
        kinds = ["ctx"] * 40
        kinds[5] = kinds[30] = "theirs"
        self.assertEqual(len(conflict_ranges(kinds)), 2)

    def test_no_conflict(self):
        self.assertEqual(conflict_ranges(["ctx", "ctx"]), [])


if __name__ == "__main__":
    unittest.main()
