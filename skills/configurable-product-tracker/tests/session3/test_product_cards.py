import unittest

from analytics.product_cards import build_product_cards


class ProductCards(unittest.TestCase):
    def test_previous_calendar_day_same_verified_configuration(self):
        product={'entity_type':'product','product_id':'p','name':'Example','brand':'Vooglam','market':'US'}
        lens={'entity_type':'lens_configuration','lens_config_id':'lens','selection_path':'Standard Lenses',
              'original_labels':{'lens_path':'Standard Lenses','technology':'Standard Lenses'}}
        base={'entity_type':'price_observation','product_id':'p','variant_id':'v','lens_config_id':'lens',
              'market':'US','currency':'USD','source_kind':'public_observation','status':'ok',
              'price_basis':'cart subtotal','history_group_key':'config-a'}
        day1={**base,'observed_at':'2026-09-26T12:00:00+08:00','quoted_subtotal':'100','evidence_id':'one'}
        day2={**base,'observed_at':'2026-09-27T12:00:00+08:00','quoted_subtotal':'110','evidence_id':'two'}
        result=build_product_cards({'records':[product,lens,day1,day2]})[0]['featured']['standard']
        self.assertEqual(result['change']['value'],'10.0')
        day1['history_group_key']='different-config'
        result=build_product_cards({'records':[product,lens,day1,day2]})[0]['featured']['standard']
        self.assertEqual(result['change']['status'],'unavailable')
        day1['history_group_key']='config-a'
        day1['observed_at']='2026-09-25T12:00:00+08:00'
        result=build_product_cards({'records':[product,lens,day1,day2]})[0]['featured']['standard']
        self.assertEqual(result['change']['status'],'unavailable')


if __name__=='__main__':
    unittest.main()
