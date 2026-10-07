import unittest

from analytics.lens_fields import structure_lens_fields


class LensFields(unittest.TestCase):
    def test_vooglam_labels_are_separate_without_guessing_missing_fields(self):
        row = {'entity_type': 'lens_configuration', 'original_labels': {
            'lens_path': 'Standard Lenses', 'technology': 'Advanced Lenses',
            'material': '未经过材料页', 'cart_configuration': '1.61 High-Index'}}
        structure_lens_fields({'records': [row]})
        self.assertEqual((row['lens_function'], row['technology'], row['refractive_index']),
                         ('普通透明', 'Advanced Lenses', '1.61'))
        self.assertIsNone(row['material'])
        self.assertIsNone(row['coating'])

    def test_firmoo_label_pairs(self):
        row = {'entity_type': 'lens_configuration', 'original_labels': [
            ['type', 'Clear'], ['index', '1.56 Index'], ['coating', 'No Coating-FREE']]}
        structure_lens_fields({'records': [row]})
        self.assertEqual((row['lens_function'], row['refractive_index'], row['coating']),
                         ('普通透明', '1.56', 'No Coating-FREE'))

    def test_combined_functions_remain_visible(self):
        row = {'entity_type': 'lens_configuration', 'original_labels': {
            'lens_path': 'Photochromic → Photochromic Blue Light Blocking'}}
        structure_lens_fields({'records': [row]})
        self.assertEqual(row['lens_function'], '变色、防蓝光')


if __name__ == '__main__':
    unittest.main()
