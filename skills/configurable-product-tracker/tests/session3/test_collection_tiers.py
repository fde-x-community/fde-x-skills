import json
from pathlib import Path
import unittest

from firmoo_lens_tree import scoped_children
from skill.live import TIERS


ROOT = Path(__file__).resolve().parents[2]


class CollectionTiers(unittest.TestCase):
    def test_vooglam_classic_is_the_three_dashboard_paths(self):
        seed_name, no_expand, limit = TIERS['classic']
        seeds = json.loads((ROOT / 'scripts' / seed_name).read_text(encoding='utf-8'))
        self.assertEqual([seed['lens_type'] for seed in seeds],
                         ['Standard Lenses', 'Blue Light Blocking', 'Driving Lenses'])
        self.assertTrue(no_expand)
        self.assertEqual(limit, 3)
        medium_name, medium_no_expand, medium_limit = TIERS['medium']
        self.assertEqual(len(json.loads((ROOT / 'scripts' / medium_name).read_text(encoding='utf-8'))), 9)
        self.assertTrue(medium_no_expand)
        self.assertEqual(medium_limit, 9)
        self.assertEqual(TIERS['full'], (medium_name, False, 0))

    def test_firmoo_scopes_visible_choices(self):
        categories = [{'label': name} for name in
                      ('Clear', 'Photochromic & Transitions®', 'Blue-light Blocking',
                       'Tint & Polarized', 'Driving', 'Featured - LED Pro Lenses')]
        self.assertEqual([item['label'] for item in scoped_children([], categories, 'classic')],
                         ['Clear', 'Blue-light Blocking', 'Driving'])
        second = [{'label': 'first'}, {'label': 'second'}]
        self.assertEqual(scoped_children([categories[0]], second, 'classic'), second[:1])
        self.assertEqual(scoped_children([categories[0]], second, 'subtypes'), second)
        self.assertEqual(scoped_children([categories[0], second[0]], second, 'subtypes'), second[:1])
        self.assertEqual(scoped_children([categories[0], second[0]], second, 'all'), second)


if __name__ == '__main__':
    unittest.main()
