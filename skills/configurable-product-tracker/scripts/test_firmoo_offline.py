import unittest
from firmoo_lens_tree import parse_cart, parse_summary, validate_url, scoped_children, sidebar_model, require_model, ProductIdentityMismatch


class FirmooPriceTests(unittest.TestCase):
    def test_lens_summary_model_is_not_product_id(self):
        self.assertEqual(sidebar_model("GBP(£)\nM52860(C4)\n£24.00"), "M52860")
        self.assertEqual(sidebar_model("USD($)\nDBSN62320(C1)\n$25.99"), "DBSN62320")
        with self.assertRaises(ProductIdentityMismatch):
            sidebar_model("GBP(£)\n£24.00")

    def test_cross_market_identity_guard(self):
        self.assertIsNone(require_model("M52860", "M52860", "uk"))
        with self.assertRaisesRegex(ProductIdentityMismatch, "DBSN62320.*AC02666"):
            require_model("AC02666", "DBSN62320", "uk")
    def test_second_level_mode_covers_every_secondary_choice(self):
        options = [{"label": "Daily Use"}, {"label": "Heavy Screen Use"}, {"label": "Goldora"}]
        self.assertEqual(scoped_children([], options, "subtypes"), options)
        self.assertEqual(scoped_children([{"label": "Blue-light Blocking"}], options, "subtypes"), options)
        self.assertEqual(len(scoped_children([{}, {}], options, "subtypes")), 1)
        self.assertEqual(scoped_children([{}, {}], options, "all"), options)

    def cart(self, symbol="$", currency="USD", count=1):
        return (f"{currency}({symbol})\nMy Shopping Cart ({count})\nFrame: S939\n{symbol}26.99\n"
                f"Color: Pink, Clear\nLens DetailsEdit lens\n{symbol}4.95\nGLASSES TYPE:\nNON-RX\n"
                f"{symbol}0.00\nQty:\n-\n+\nRemove\nSubtotal\n{symbol}31.94\n"
                f"Accessories\n{symbol}999.99\nOrder Total\n{symbol}30.00")

    def test_item_prices_exclude_accessories_and_coupon_total(self):
        prices = parse_cart(self.cart(), "USD")
        self.assertEqual(prices["item_total"], "31.94")
        self.assertEqual(prices["lens_price"], "4.95")

    def test_uk_currency(self):
        self.assertEqual(parse_cart(self.cart("£", "GBP"), "GBP")["currency"], "GBP")

    def test_reject_multiple_items(self):
        with self.assertRaises(ValueError):
            parse_cart(self.cart(count=2), "USD")

    def test_reject_bad_sum(self):
        with self.assertRaises(ValueError):
            parse_cart(self.cart().replace("Subtotal\n$31.94", "Subtotal\n$30.94"), "USD")

    def test_reject_wrong_market_currency(self):
        with self.assertRaises(ValueError):
            parse_cart(self.cart(), "GBP")

    def test_summary_is_not_a_cart(self):
        text = "USD($)\nS939(C2)\n$26.99\nLens Price\n$4.95\nClear\nSubtotal:\n$31.94"
        self.assertEqual(parse_summary(text, "USD")["item_total"], "31.94")
        with self.assertRaises(ValueError):
            parse_cart(text, "USD")

    def test_url_market_isolation(self):
        self.assertEqual(validate_url("https://www.firmoo.co.uk/eyeglasses-p-4611.html?color=21101", "uk"), "4611")
        with self.assertRaises(ValueError):
            validate_url("https://www.firmoo.com/eyeglasses-p-4611.html", "uk")
        with self.assertRaises(ValueError):
            validate_url("https://www.firmoo.com/", "us")


if __name__ == "__main__":
    unittest.main()
