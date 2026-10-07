from playwright.sync_api import sync_playwright
import re
import json
import time


URL = "https://www.vooglam.com/goods-detail/9667"


# ============================================================
# Utils
# ============================================================

def clean(text):
    if not text:
        return None
    return re.sub(r"\s+", " ", text).strip()


def safe_text(locator):
    try:
        if locator.count() == 0:
            return None
        return clean(locator.first.inner_text())
    except Exception:
        return None


def extract_after_label(page, label):
    """
    从 body 文本中尝试匹配：

    Frame Shape
    Rectangle

    或：

    Frame Shape: Rectangle
    """

    body = page.locator("body").inner_text()

    patterns = [
        rf"{re.escape(label)}\s*:\s*([^\n]+)",
        rf"{re.escape(label)}\s*\n+\s*([^\n]+)"
    ]

    for pattern in patterns:
        m = re.search(pattern, body, re.IGNORECASE)

        if m:
            return clean(m.group(1))

    return None


def dump_clickables(page, keyword=None, limit=200):
    """
    打印当前页面所有可点击元素。
    用于调试 DOM / selector。
    """

    selector = """
    button,
    [role="button"],
    a,
    label,
    [onclick],
    input[type="button"],
    input[type="submit"]
    """

    items = page.locator(selector)

    count = min(items.count(), limit)

    result = []

    for i in range(count):

        try:

            el = items.nth(i)

            text = clean(el.inner_text())

            if not text:
                text = clean(el.get_attribute("aria-label"))

            if not text:
                text = clean(el.get_attribute("title"))

            if not text:
                continue

            if keyword and keyword.lower() not in text.lower():
                continue

            item = {
                "index": i,
                "text": text,
                "tag": el.evaluate("(e) => e.tagName"),
                "class": el.get_attribute("class")
            }

            result.append(item)

            print(
                f"[{i}]",
                repr(text),
                "tag=",
                item["tag"],
                "class=",
                item["class"]
            )

        except Exception:
            pass

    return result


# ============================================================
# Basic product info
# ============================================================

def scrape_basic_product_info(page):

    body_text = page.locator("body").inner_text()

    # --------------------------------------------------------
    # title
    # --------------------------------------------------------

    title = safe_text(
        page.locator("h1")
    )

    # --------------------------------------------------------
    # product code
    # --------------------------------------------------------

    product_code = extract_after_label(
        page,
        "Product Code"
    )

    # --------------------------------------------------------
    # shape
    # --------------------------------------------------------

    frame_shape = extract_after_label(
        page,
        "Frame Shape"
    )

    # --------------------------------------------------------
    # material
    # --------------------------------------------------------

    frame_material = extract_after_label(
        page,
        "Frame Materials"
    )

    if not frame_material:
        frame_material = extract_after_label(
            page,
            "Frame Material"
        )

    # --------------------------------------------------------
    # color
    # --------------------------------------------------------

    frame_color = extract_after_label(
        page,
        "Frame Color"
    )

    # --------------------------------------------------------
    # frame size
    # --------------------------------------------------------

    frame_size = extract_after_label(
        page,
        "Frame Size"
    )

    # --------------------------------------------------------
    # all prices
    # --------------------------------------------------------

    all_prices = re.findall(
        r"\$(\d+(?:\.\d{1,2})?)",
        body_text
    )

    all_prices_float = []

    for x in all_prices:
        try:
            all_prices_float.append(float(x))
        except:
            pass

    print("\nALL PRICES:")
    print(all_prices_float)

    # --------------------------------------------------------
    # try to locate main product price
    # --------------------------------------------------------

    price = None

    # 优先找 h1 附近或 price class
    price_selectors = [
        '[class*="price"]',
        '[class*="Price"]',
        '[data-testid*="price"]'
    ]

    for selector in price_selectors:

        try:

            nodes = page.locator(selector)

            for i in range(min(nodes.count(), 20)):

                txt = clean(nodes.nth(i).inner_text())

                if not txt:
                    continue

                m = re.search(
                    r"\$(\d+(?:\.\d{1,2})?)",
                    txt
                )

                if not m:
                    continue

                value = float(m.group(1))

                # 排除 $0
                if value > 0:
                    price = value
                    break

            if price is not None:
                break

        except Exception:
            pass

    # fallback
    if price is None:

        for p in all_prices_float:

            if p > 0:

                price = p
                break

    # --------------------------------------------------------
    # dimensions
    # --------------------------------------------------------

    mm_values = [
        int(x)
        for x in re.findall(
            r"(\d+)\s*mm",
            body_text,
            re.IGNORECASE
        )
    ]

    # --------------------------------------------------------
    # visible lens keywords
    # --------------------------------------------------------

    lens_keywords = [
        "Single Vision",
        "Progressive",
        "Bifocal",
        "Reader",
        "Readers",
        "Non-Prescription",
        "Blue Light Blocking",
        "Photochromic",
        "Transitions",
        "Color Tint",
        "Polarized",
        "Driving"
    ]

    lens_options = []

    lower_body = body_text.lower()

    for keyword in lens_keywords:

        if keyword.lower() in lower_body:

            lens_options.append(keyword)

    return {
        "source_url": page.url,
        "title": title,
        "product_code": product_code,
        "price_usd": price,
        "frame_color": frame_color,
        "frame_shape": frame_shape,
        "frame_material": frame_material,
        "frame_size": frame_size,
        "raw_mm_values": mm_values,
        "visible_lens_keywords": lens_options
    }


# ============================================================
# Lens flow
# ============================================================

def click_add_lens(page):

    print("\n================================================")
    print("SEARCHING ADD LENS BUTTON")
    print("================================================\n")

    # 先打印包含 lens 的 clickable
    dump_clickables(
        page,
        keyword="lens"
    )

    candidates = [
        page.get_by_role(
            "button",
            name=re.compile(
                r"add.*lens",
                re.I
            )
        ),

        page.get_by_text(
            re.compile(
                r"add.*lens",
                re.I
            )
        ),

        page.locator(
            'text=/ADD\\s+LENS/i'
        )
    ]

    for locator in candidates:

        try:

            if locator.count() > 0:

                btn = locator.first

                print(
                    "\nFound ADD LENS:",
                    safe_text(btn)
                )

                btn.scroll_into_view_if_needed()

                time.sleep(0.5)

                btn.click(
                    timeout=10000
                )

                return True

        except Exception as e:

            print(
                "Candidate failed:",
                e
            )

    return False


def extract_visible_prescription_types(page):

    keywords = [
        "Single Vision",
        "Progressive",
        "Bifocal",
        "Readers",
        "Reader",
        "Non-Prescription",
        "Distance",
        "Reading"
    ]

    found = []

    for keyword in keywords:

        try:

            locator = page.get_by_text(
                re.compile(
                    re.escape(keyword),
                    re.I
                )
            )

            if locator.count() > 0:

                found.append(keyword)

        except Exception:
            pass

    return list(dict.fromkeys(found))


def extract_lens_indices(page):

    body = page.locator("body").inner_text()

    matches = re.findall(
        r"\b1\.(?:50|53|56|57|59|60|61|64|67|70|74)\b",
        body
    )

    return list(
        dict.fromkeys(matches)
    )


def extract_visible_prices(page):

    body = page.locator("body").inner_text()

    prices = re.findall(
        r"\$(\d+(?:\.\d{1,2})?)",
        body
    )

    result = []

    for p in prices:

        try:

            value = float(p)

            if value not in result:

                result.append(value)

        except:
            pass

    return result


def scrape_lens_panel(page):

    print("\n================================================")
    print("OPENING LENS CONFIGURATION")
    print("================================================\n")

    success = click_add_lens(page)

    if not success:

        print("\nERROR: Could not find ADD LENS button.")

        return {
            "lens_panel_opened": False
        }

    time.sleep(2)

    print("\n================================================")
    print("AFTER ADD LENS CLICK")
    print("================================================\n")

    # screenshot
    page.screenshot(
        path="after_add_lens.png",
        full_page=True
    )

    print(
        "Saved screenshot:",
        "after_add_lens.png"
    )

    # body tail
    body = page.locator(
        "body"
    ).inner_text()

    print("\nLAST 6000 CHARACTERS OF PAGE:\n")

    print(
        body[-6000:]
    )

    print("\n================================================")
    print("CLICKABLE ITEMS AFTER OPENING LENS PANEL")
    print("================================================\n")

    clickables = dump_clickables(
        page,
        limit=300
    )

    prescription_types = extract_visible_prescription_types(
        page
    )

    indices = extract_lens_indices(
        page
    )

    prices = extract_visible_prices(
        page
    )

    print(
        "\nPrescription types:",
        prescription_types
    )

    print(
        "\nLens indices:",
        indices
    )

    print(
        "\nVisible prices:",
        prices
    )

    return {
        "lens_panel_opened": True,
        "prescription_types": prescription_types,
        "lens_indices": indices,
        "visible_prices": prices,
        "clickables": clickables
    }


# ============================================================
# Try click Single Vision
# ============================================================

def try_single_vision(page):

    print("\n================================================")
    print("TRY SINGLE VISION")
    print("================================================\n")

    candidates = [
        page.get_by_role(
            "button",
            name=re.compile(
                r"single\s*vision",
                re.I
            )
        ),

        page.get_by_text(
            re.compile(
                r"single\s*vision",
                re.I
            )
        )
    ]

    for locator in candidates:

        try:

            if locator.count() == 0:

                continue

            btn = locator.first

            print(
                "Found Single Vision:",
                safe_text(btn)
            )

            btn.scroll_into_view_if_needed()

            btn.click(
                timeout=10000
            )

            time.sleep(1.5)

            page.screenshot(
                path="after_single_vision.png",
                full_page=True
            )

            print(
                "Saved screenshot:",
                "after_single_vision.png"
            )

            print("\nCLICKABLE ITEMS:\n")

            clickables = dump_clickables(
                page,
                limit=300
            )

            indices = extract_lens_indices(
                page
            )

            prices = extract_visible_prices(
                page
            )

            body = page.locator(
                "body"
            ).inner_text()

            print("\nLAST 5000 CHARS:\n")

            print(
                body[-5000:]
            )

            return {
                "single_vision_clicked": True,
                "lens_indices": indices,
                "visible_prices": prices,
                "clickables": clickables
            }

        except Exception as e:

            print(
                "Single Vision click failed:",
                e
            )

    return {
        "single_vision_clicked": False
    }


# ============================================================
# Main
# ============================================================

def main():

    final_result = {
        "url": URL
    }

    with sync_playwright() as p:

        browser = p.chromium.launch(
            headless=False,
            slow_mo=200
        )

        context = browser.new_context(
            viewport={
                "width": 1440,
                "height": 1000
            },

            locale="en-US"
        )

        page = context.new_page()

        print("\n================================================")
        print("OPEN PAGE")
        print("================================================\n")

        page.goto(
            URL,
            wait_until="networkidle",
            timeout=60000
        )

        time.sleep(1)

        print(
            "Loaded:",
            page.title()
        )

        # ----------------------------------------------------
        # Basic product
        # ----------------------------------------------------

        print("\n================================================")
        print("SCRAPE BASIC PRODUCT")
        print("================================================\n")

        basic = scrape_basic_product_info(
            page
        )

        final_result[
            "product"
        ] = basic

        print(
            json.dumps(
                basic,
                ensure_ascii=False,
                indent=2
            )
        )

        # ----------------------------------------------------
        # Lens configuration
        # ----------------------------------------------------

        lens_panel = scrape_lens_panel(
            page
        )

        final_result[
            "lens_panel"
        ] = lens_panel

        # ----------------------------------------------------
        # Try Single Vision
        # ----------------------------------------------------

        if lens_panel.get(
            "lens_panel_opened"
        ):

            single_vision = try_single_vision(
                page
            )

            final_result[
                "single_vision"
            ] = single_vision

        # ----------------------------------------------------
        # Save final JSON
        # ----------------------------------------------------

        with open(
            "vooglam_result.json",
            "w",
            encoding="utf-8"
        ) as f:

            json.dump(
                final_result,
                f,
                ensure_ascii=False,
                indent=2
            )

        print("\n================================================")
        print("DONE")
        print("================================================\n")

        print(
            "Saved JSON:",
            "vooglam_result.json"
        )

        print(
            "Saved screenshot:",
            "after_add_lens.png"
        )

        print(
            "Saved screenshot:",
            "after_single_vision.png"
        )

        input(
            "\n浏览器暂时不会关闭。"
            "观察页面后按 Enter 退出..."
        )

        browser.close()


if __name__ == "__main__":
    main()