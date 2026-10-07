from playwright.sync_api import sync_playwright
import hashlib
import re
import json
import time
from datetime import datetime
import sys
import argparse
from pathlib import Path
from copy import deepcopy
from decimal import Decimal
from urllib.parse import urlsplit


URL = "https://www.vooglam.com/goods-detail/9667"
SCRIPT_VERSION = "18-20260927"
MASTER_PATH = Path(__file__).resolve().with_name("vooglam_lens_tree_master.json")

# 每次运行独立保存，避免把上一次的截图误当成这一次的结果。
OUT_DIR = Path("vooglam_lens_tree") / datetime.now().strftime("run_%Y%m%d_%H%M%S")
OUT_DIR.mkdir(parents=True, exist_ok=True)


def configure_product(url):
    """Keep each product's live data isolated; 9667 retains its existing master."""
    global URL, MASTER_PATH
    parts = urlsplit(url)
    match = re.fullmatch(r"/goods-detail/(\d+)/?", parts.path)
    if parts.scheme != "https" or parts.netloc != "www.vooglam.com" or not match or parts.query or parts.fragment:
        raise ValueError("Expected https://www.vooglam.com/goods-detail/<numeric-id>")
    product_id = match.group(1)
    URL = f"https://www.vooglam.com/goods-detail/{product_id}"
    base = Path(__file__).resolve().parent
    MASTER_PATH = (base / "vooglam_lens_tree_master.json" if product_id == "9667" else
                   base / "vooglam_products" / product_id / "vooglam_lens_tree_master.json")
    MASTER_PATH.parent.mkdir(parents=True, exist_ok=True)
    return product_id


# ============================================================
# 基础工具
# ============================================================

def clean(text):
    if not text:
        return None
    return re.sub(r"\s+", " ", text).strip()


def slugify(text):
    text = re.sub(r"[^\w\-]+", "_", text.strip(), flags=re.UNICODE)
    return text.strip("_").lower()


def output_path(filename):
    """Keep new evidence paths short; existing saved paths remain untouched."""
    return OUT_DIR / (hashlib.sha256(filename.encode("utf-8")).hexdigest()[:20] + Path(filename).suffix)


def save_json(obj, filename):
    path = output_path(filename)
    path.write_text(
        json.dumps(obj, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print("saved json:", path)


def screenshot(page, filename):
    path = output_path(filename)
    page.screenshot(
        path=str(path),
        full_page=False
    )
    print("saved screenshot:", path)


def dump_text(page, filename):
    text = page.locator("body").inner_text()

    path = output_path(filename)
    path.write_text(
        text,
        encoding="utf-8"
    )

    print("saved text:", path)

    return text

def wait_for_text_visible(page, text, timeout=15000):
    """
    等某个业务状态真正出现，而不是固定 sleep。
    """
    locator = page.get_by_text(
        text,
        exact=False
    )

    try:
        locator.first.wait_for(
            state="visible",
            timeout=timeout
        )
        print("state ready:", text)
        return True
    except Exception as e:
        print("wait state failed:", text, e)
        return False
def dump_clickables(page, filename):
    """
    保存当前可见可点击元素。
    """

    nodes = page.locator(
        """
        button:visible,
        [role="button"]:visible,
        a:visible,
        label:visible
        """
    )

    result = []

    for i in range(nodes.count()):

        node = nodes.nth(i)

        try:
            text = clean(node.inner_text())

            if not text:
                text = clean(
                    node.get_attribute("aria-label")
                )

            if not text:
                text = clean(
                    node.get_attribute("title")
                )

            if not text:
                continue

            result.append({
                "index": i,
                "text": text,
                "tag": node.evaluate("(e) => e.tagName"),
                "class": node.get_attribute("class")
            })

        except Exception:
            pass

    save_json(
        result,
        filename
    )

    return result


# ============================================================
# Cookie
# ============================================================

def accept_cookies_if_present(page):
    """
    Cookie banner 会挡操作时再点。
    只精确匹配 Accept Cookies。
    """

    locator = page.get_by_text(
        "Accept Cookies",
        exact=True
    )

    for i in range(locator.count()):

        node = locator.nth(i)

        try:
            if node.is_visible():
                node.click(timeout=3000)
                page.wait_for_timeout(300)
                print("accepted cookies")
                return True
        except Exception:
            pass

    return False


# ============================================================
# 打开 Lens 流程
# ============================================================

def click_select_lenses(page):

    buttons = page.locator(
        "button.goods-detail-button.primary"
    ).filter(
        has_text=re.compile(
            r"select\s+lenses",
            re.I
        )
    )

    print(
        "Select Lenses candidates:",
        buttons.count()
    )

    for i in range(buttons.count()):

        btn = buttons.nth(i)

        try:

            if not btn.is_visible():
                continue

            btn.scroll_into_view_if_needed()

            page.wait_for_timeout(200)

            btn.click(
                timeout=10000
            )

            page.wait_for_timeout(900)

            print("opened Select Lenses")

            return True

        except Exception as e:

            print(
                "Select Lenses failed:",
                e
            )

    return False


def reset_lens_flow(page):

    print("\nRESET PRODUCT")

    page.goto(
        URL,
        wait_until="domcontentloaded",
        timeout=60000
    )
    deadline = time.monotonic() + 20
    opened = False
    while time.monotonic() < deadline:
        accept_cookies_if_present(page)
        if click_select_lenses(page):
            opened = True
            break
        page.wait_for_timeout(350)
    if not opened:
        raise RuntimeError(
            "Could not open Select Lenses"
        )


# ============================================================
# Prescription Type
# ============================================================

def find_prescription_card(page, name):

    cards = page.locator(
        "li.item-box"
    )

    result = []

    for i in range(cards.count()):

        card = cards.nth(i)

        try:

            if not card.is_visible():
                continue

            text = clean(
                card.inner_text()
            )

            if not text:
                continue

            # Card 开头就是 prescription name
            if text.lower().startswith(
                name.lower()
            ):
                result.append(card)

        except Exception:
            pass

    return result


def click_prescription_type(page, name):
    deadline = time.monotonic() + 15
    cards = []
    while time.monotonic() < deadline:
        cards = find_prescription_card(page, name)
        if cards:
            break
        page.wait_for_timeout(250)

    print(
        name,
        "cards:",
        len(cards)
    )

    if not cards:
        return False

    card = cards[0]

    try:

        card.scroll_into_view_if_needed()

        card.click(
            timeout=10000
        )

        page.wait_for_timeout(900)

        print(
            "clicked:",
            name
        )

        return True

    except Exception as e:

        print(
            "failed clicking prescription:",
            e
        )

        return False


# ============================================================
# Element Plus Select
# ============================================================

def get_visible_selects(page):

    selects = page.locator(
        ".el-select:visible"
    )

    result = []

    for i in range(
        selects.count()
    ):

        node = selects.nth(i)

        try:
            if node.bounding_box():
                result.append(node)
        except Exception:
            pass

    return result


def get_dropdown_options(page):
    values = page.locator(".el-select-dropdown__item:visible").all_inner_texts()
    return [text for value in values if (text := clean(value))]


def choose_select_option(page, select_node, preferred_values, label):
    """Use fixed test values without enumerating supported degrees."""
    try:
        field = select_node.locator("input").first
        current = field.input_value().strip()
        targets = {v.strip().lower() for v in preferred_values}
        if current.lower() in targets:
            print("already selected:", label, current)
            return current
        if not field.is_enabled():
            return None
        select_node.click(timeout=6000)
        pattern = re.compile(r"^\s*(?:" + "|".join(
            re.escape(v) for v in preferred_values) + r")\s*$", re.I)
        page.locator(".el-select-dropdown__item:visible").filter(
            has_text=pattern).first.click(timeout=6000)
        actual = field.input_value().strip()
        if actual.lower() in targets:
            print("selected:", label, actual)
            return actual
    except Exception as exc:
        print("fixed value selection failed:", label, str(exc))
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    return None


# ============================================================
# Single Vision 处方
# ============================================================

def fill_single_vision_prescription(page):

    selects = get_visible_selects(
        page
    )

    print(
        "visible selects:",
        len(selects)
    )

    if len(selects) < 7:

        return {
            "success": False,
            "reason": "less than 7 selects",
            "count": len(selects)
        }

    values = {}

    mapping = [
        (
            0,
            "od_sph",
            ["0.00", "+0.00", "Plano", "0"]
        ),
        (
            1,
            "od_cyl",
            ["0.00", "+0.00", "0"]
        ),
        (
            2,
            "od_axis",
            ["0", "1", "001"]
        ),
        (
            3,
            "os_sph",
            ["0.00", "+0.00", "Plano", "0"]
        ),
        (
            4,
            "os_cyl",
            ["0.00", "+0.00", "0"]
        ),
        (
            5,
            "os_axis",
            ["0", "1", "001"]
        ),
        (
            6,
            "pd",
            ["66.00", "66"]
        ),
    ]

    for index, key, prefs in mapping:

        value = choose_select_option(
            page,
            selects[index],
            prefs,
            key
        )

        values[key] = value

    screenshot(
        page,
        "single_vision_form_filled.png"
    )

    # 关键字段未选中时不能把表单算作成功。
    required = ("od_sph", "od_cyl", "os_sph", "os_cyl", "pd")
    return {
        "success": all(values[key] is not None for key in required),
        "values": values
    }


def click_button_exact(page, text, timeout=10000):
    """优先 Playwright click，失败后用真实指针点按钮中心并验证后续状态。"""
    pattern = re.compile(rf"^\s*{re.escape(text)}\s*$", re.I)
    buttons = page.locator("button:visible").filter(has_text=pattern)
    diagnostics = []
    for i in range(buttons.count()):
        button = buttons.nth(i)
        box = button.bounding_box()
        info = {"text": text, "class": button.get_attribute("class"),
                "enabled": button.is_enabled(), "box": box}
        diagnostics.append(info)
        if not info["enabled"] or not box:
            continue
        try:
            button.click(timeout=timeout)
            return True
        except Exception as exc:
            info["click_error"] = str(exc)
            # 不调用 JS click/force click；真实鼠标事件更接近用户操作。
            try:
                page.mouse.click(box["x"] + box["width"] / 2,
                                 box["y"] + box["height"] / 2)
                return True
            except Exception as mouse_exc:
                info["mouse_error"] = str(mouse_exc)
    # 部分组件将按钮文字放在子元素中，locator 文本过滤可能漏掉。
    fallback = page.evaluate("""text => Array.from(document.querySelectorAll('button'))
        .filter(el => (el.innerText || '').trim().toUpperCase() === text.toUpperCase())
        .map(el => { const r = el.getBoundingClientRect();
            return {x:r.x + r.width/2, y:r.y + r.height/2,
                    width:r.width, height:r.height, disabled:el.disabled}; })
        .filter(r => r.width > 0 && r.height > 0 && !r.disabled)""", text)
    if fallback:
        page.mouse.click(fallback[0]["x"], fallback[0]["y"])
        return True
    save_json(diagnostics, f"{slugify(text)}_button_debug.json")
    return False


def wait_for_either_state(page, states, timeout=15000):
    """等待某个状态出现；一次等待即可处理可选确认页。"""
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        for label, content in states.items():
            matches = page.get_by_text(content, exact=False)
            if any(matches.nth(i).is_visible() for i in range(matches.count())):
                return label
        page.wait_for_timeout(250)
    return None


def submit_and_confirm_single_vision(page):
    screenshot(page, "before_submit.png")
    if not click_button_exact(page, "SUBMIT"):
        dump_clickables(page, "submit_failed_clickables.json")
        dump_text(page, "submit_failed.txt")
        return {"success": False, "stage": "submit"}

    state = wait_for_either_state(page, {
        "confirm": "Does this match your prescription",
        "lens_type": "Select A Lens Type",
    })
    if state == "confirm":
        screenshot(page, "single_vision_confirmation.png")
        if not click_button_exact(page, "CONFIRM"):
            dump_clickables(page, "confirm_failed_clickables.json")
            return {"success": False, "stage": "confirm"}
        state = wait_for_either_state(page, {"lens_type": "Select A Lens Type"})
    if state != "lens_type":
        screenshot(page, "single_vision_after_submit_failed.png")
        dump_text(page, "single_vision_after_submit_failed.txt")
        return {"success": False, "stage": "wait_lens_type"}
    return {"success": True}


# ============================================================
# Lens Type 第一层提取
# ============================================================

KNOWN_LENS_TYPES = [
    "Standard Lenses",
    "Blue Light Blocking",
    "Photochromic",
    "Transitions®",
    "Color Tint",
    "Polarized Lenses",
    "Driving Lenses",
]


def inspect_lens_type_cards(page):
    """从可见文本节点定位配镜区卡片；不会把导航文字算成镜片。"""
    return page.evaluate(r"""names => {
        const normalize = s => (s || '').replace(/\s+/g, ' ').trim();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const rows = [], seen = new Set();
        while (walker.nextNode()) {
            const title = normalize(walker.currentNode.nodeValue);
            if (!names.includes(title) || seen.has(title)) continue;
            let el = walker.currentNode.parentElement;
            const titleBox = el?.getBoundingClientRect();
            if (!titleBox || titleBox.width === 0 || titleBox.height === 0 ||
                titleBox.x < window.innerWidth * .45 ||
                titleBox.x >= window.innerWidth ||
                titleBox.y < 0 || titleBox.y >= window.innerHeight) continue;
            const titleX = titleBox.x + titleBox.width / 2;
            const titleY = titleBox.y + titleBox.height / 2;
            let card = el;
            for (let step = 0; step < 8 && el.parentElement; step++) {
                const parent = el.parentElement;
                const box = parent.getBoundingClientRect();
                const contents = normalize(parent.innerText);
                if (box.x < window.innerWidth * .4 || box.right > window.innerWidth ||
                    box.width > window.innerWidth * .6 ||
                    box.height > 220 || contents.length > 500 ||
                    names.some(n => n !== title && contents.includes(n))) break;
                if (box.width > 250) card = parent;
                el = parent;
            }
            const box = card.getBoundingClientRect();
            rows.push({name: title, text: normalize(card.innerText),
                       title_x: titleX, title_y: titleY,
                       card_box: {x: box.x, y: box.y, width: box.width, height: box.height}});
            seen.add(title);
        }
        return rows;
    }""", KNOWN_LENS_TYPES)


def parse_lens_type_cards(page):
    rows = inspect_lens_type_cards(page)
    save_json(rows, "lens_type_dom_debug.json")
    result = []
    for row in rows:
        content = row["text"]
        match = re.search(r"\$([0-9]+(?:\.[0-9]{1,2})?)", content)
        description = clean(re.sub(r"\$[0-9]+(?:\.[0-9]{1,2})?", "",
                                   content.replace(row["name"], "", 1)))
        result.append({"name": row["name"],
                       "displayed_price": float(match.group(1)) if match else None,
                       "description": description or None})
    return result


def lens_type_section_lines(page, name):
    """只读配镜列表中本类型至下一类型之间的可见文字。"""
    lines = [clean(line) for line in page.locator("body").inner_text().splitlines()]
    try:
        start = max(i for i, line in enumerate(lines) if line == "Select A Lens Type")
        start = next(i for i in range(start + 1, len(lines)) if lines[i] == name)
    except (ValueError, StopIteration):
        return []
    result = []
    for line in lines[start + 1:]:
        if line in KNOWN_LENS_TYPES:
            break
        if line:
            result.append(line)
    return result


def click_lens_type(page, name):
    accept_cookies_if_present(page)
    # 列表底部被固定操作栏遮挡；先在右侧面板内滚动到可点击区域。
    match = None
    for _ in range(7):
        rows = inspect_lens_type_cards(page)
        match = next((row for row in rows if row["name"] == name), None)
        if match:
            box = match["card_box"]
            center_y = box["y"] + box["height"] / 2
            if 90 <= center_y <= 825:
                break
            direction = 350 if center_y > 825 else -350
        else:
            direction = 350
        page.mouse.move(1100, 600)
        page.mouse.wheel(0, direction)
        page.wait_for_timeout(300)
    else:
        match = None
    if not match:
        print("No visible lens card:", name)
        return {"clicked": False, "action": "card_not_found"}
    box = match["card_box"]
    expandable = name in ("Photochromic", "Transitions®", "Color Tint")
    before_section = lens_type_section_lines(page, name) if expandable else []
    attempts = []
    # 第一击靠箭头/卡片，若没有状态变化，先清掉延迟出现的 Cookie 横幅，再点标题区域。
    for attempt in range(2):
        cookies_cleared = accept_cookies_if_present(page)
        rows = inspect_lens_type_cards(page)
        row = next((r for r in rows if r["name"] == name), None)
        if not row:
            break
        box = row["card_box"]
        x = (box["x"] + box["width"] - 32 if expandable else box["x"] + box["width"] / 2)
        if attempt:
            x = row["title_x"] + 12
        y = row["title_y"] + 10 if attempt else box["y"] + box["height"] / 2
        page.mouse.click(x, y)
        attempts.append({"x": round(x), "y": round(y), "cookies_cleared": cookies_cleared})
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            page.wait_for_timeout(300)
            if expandable:
                after_section = lens_type_section_lines(page, name)
                if len(after_section) >= len(before_section) + 2:
                    return {"clicked": True, "action": "expanded",
                            "section_lines": after_section, "attempts": attempts}
                continue

            next_button = page.get_by_role("button", name="NEXT", exact=True)
            if next_button.count() and next_button.first.is_visible() and next_button.first.is_enabled():
                next_button.first.click(timeout=8000)
                page.wait_for_timeout(700)
                return {"clicked": True, "action": "next_clicked", "attempts": attempts}
            add_buttons = page.locator("button:visible").filter(
                has_text=re.compile("ADD TO BAG", re.I))
            if any(add_buttons.nth(i).is_enabled() for i in range(add_buttons.count())):
                return {"clicked": True, "action": "selected", "attempts": attempts}
    screenshot(page, f"{slugify(name)}__click_unchanged.png")
    dump_text(page, f"{slugify(name)}__click_unchanged.txt")
    return {"clicked": False, "action": "selection_not_verified", "attempts": attempts}


def select_expanded_child(page, child_name):
    """展开类别后点击子镜片；处方镜片再点击 NEXT。"""
    found = page.get_by_text(child_name, exact=True)
    candidates = [found.nth(i) for i in range(found.count())
                  if found.nth(i).is_visible()]
    if not candidates:
        target = page.evaluate(r"""name => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                if ((walker.currentNode.nodeValue || '').replace(/\s+/g, ' ').trim() !== name) continue;
                const el = walker.currentNode.parentElement, r = el.getBoundingClientRect();
                if (r.width && r.height && r.x > innerWidth * .45 && r.y > 70 && r.bottom < innerHeight - 90)
                    return {x:r.x+r.width/2, y:r.y+r.height/2};
            }
            return null;
        }""", child_name)
        if not target:
            return {"clicked": False, "action": "child_not_found", "child": child_name}
        page.mouse.click(target["x"], target["y"])
    else:
        candidates[-1].click(timeout=8000)
    page.wait_for_timeout(350)
    next_button = page.get_by_role("button", name="NEXT", exact=True)
    if next_button.count() and next_button.first.is_visible() and next_button.first.is_enabled():
        next_button.first.click(timeout=8000)
        page.wait_for_timeout(650)
        return {"clicked": True, "action": "next_clicked", "child": child_name}
    return {"clicked": True, "action": "child_selected", "child": child_name}


# ============================================================
# 保存某 Lens Type 下一层
# ============================================================

def capture_lens_type_detail(
    page,
    prescription,
    lens_type,
    include_clickables=False
):

    prefix = (
        f"{slugify(prescription)}"
        f"__"
        f"{slugify(lens_type)}"
    )

    screenshot(
        page,
        f"{prefix}.png"
    )

    text = dump_text(
        page,
        f"{prefix}.txt"
    )

    # Single Vision 点击 NEXT 后展示的镜片技术层：按页面原文提取两档价格与折射率。
    technology_options = []
    lines = [clean(line) for line in text.splitlines() if clean(line)]
    if "Lens Technology" in lines:
        section = lines[lines.index("Lens Technology") + 1:]
        end = next((i for i, line in enumerate(section)
                    if line in ("NEXT", "ADD TO BAG")), len(section))
        section = section[:end]
        option_names = ("Standard Lenses", "Advanced Lenses", "Premium Lenses",
                        "Special Prescription")
        for index, line in enumerate(section):
            if line not in option_names:
                continue
            tail = section[index + 1:]
            price = next((float(m.group(1)) for item in tail[:3]
                          if (m := re.fullmatch(r"\$([0-9]+(?:\.[0-9]{1,2})?)", item))), None)
            option_end = next((j for j, item in enumerate(tail)
                               if item in option_names), len(tail))
            features = [item for item in tail[:option_end]
                        if item != "Recommended for your prescription"
                        and not re.fullmatch(r"\$[0-9]+(?:\.[0-9]{1,2})?", item)]
            technology_options.append({"name": line, "price": price,
                                       "features": features})

    clickables = (dump_clickables(page, f"{prefix}_clickables.json")
                  if include_clickables else [])

    # 提取当前页面里一些可能有用的镜片词
    interesting_lines = []

    keywords = [
        "1.50",
        "1.56",
        "1.59",
        "1.60",
        "1.61",
        "1.67",
        "1.74",
        "index",
        "standard",
        "advanced",
        "premium",
        "coating",
        "anti-reflective",
        "scratch",
        "uv",
        "blue",
        "photochromic",
        "transition",
        "polarized",
        "driving",
        "thin",
        "$"
    ]

    for raw_line in text.splitlines():

        line = clean(
            raw_line
        )

        if not line:
            continue

        lower = line.lower()

        if any(
            k.lower() in lower
            for k in keywords
        ):

            interesting_lines.append(
                line
            )

    interesting_lines = list(
        dict.fromkeys(
            interesting_lines
        )
    )

    result = {
        "prescription": prescription,
        "lens_type": lens_type,
        "lens_technology_options": technology_options,
        "interesting_lines": interesting_lines,
        "clickables": clickables
    }

    save_json(
        result,
        f"{prefix}_parsed.json"
    )

    return result


def explore_lens_technology(page, prescription, lens_type, options, prepare,
                            inspect_material=False, material=None):
    """只检查指定技术选项；需要时再点 ADD TO BAG 看 Material 页面。"""
    outcomes = []
    for index, option in enumerate(options):
        entry = {"technology": option["name"], "price": option["price"]}
        try:
            if index:
                prepare(page)
                chosen = click_lens_type(page, lens_type)
                if not chosen["clicked"] or chosen["action"] != "next_clicked":
                    raise RuntimeError(f"could not return to Lens Technology: {chosen}")
            if not click_panel_label(page, option["name"]):
                raise RuntimeError("technology option is not visible")
            page.wait_for_timeout(650)
            next_button = page.get_by_role("button", name="NEXT", exact=True)
            if next_button.count() and next_button.first.is_visible() and next_button.first.is_enabled():
                next_button.first.click(timeout=8000)
                page.wait_for_timeout(650)

            prefix = (f"{slugify(prescription)}__{slugify(lens_type)}"
                      f"__{slugify(option['name'])}")
            entry["stage_after_selection"] = "Lens Technology"
            material_heading = page.get_by_text("Select Material", exact=True)
            if any(material_heading.nth(i).is_visible() for i in range(material_heading.count())):
                material_text = dump_text(page, f"{prefix}__material.txt")
                screenshot(page, f"{prefix}__material.png")
                entry.update(material_visible=True, material_encountered=True,
                             material_trigger="NEXT after Lens Technology",
                             material_options=parse_material_options(material_text),
                             material_evidence={
                                 "text": str(output_path(f"{prefix}__material.txt").resolve()),
                                 "screenshot": str(output_path(f"{prefix}__material.png").resolve())})
                if material is None:
                    entry.update(success=True, reached_stage="Select Material",
                                 page_url=page.url,
                                 observed_at=datetime.now().astimezone().isoformat())
                    outcomes.append(entry)
                    continue
                if material == "auto":
                    material = next((m["name"] for m in entry["material_options"]
                                     if m["name"] == "Standard Material"), None)
                selected_material = next((m for m in entry["material_options"]
                                          if m["name"] == material), None)
                if selected_material is None:
                    raise RuntimeError(f"Material not offered or price unparsed: {material}")
                point = page.evaluate(r"""name => {
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                    while (walker.nextNode()) {
                        if ((walker.currentNode.nodeValue || '').replace(/\s+/g,' ').trim() !== name) continue;
                        const r = walker.currentNode.parentElement.getBoundingClientRect();
                        if (r.width && r.height && r.x > innerWidth*.45 && r.right < innerWidth && r.y > 70 && r.bottom < innerHeight-90)
                            return {x:r.x+r.width/2,y:r.y+r.height/2};
                    }
                    return null;
                }""", material)
                if point is None:
                    raise RuntimeError("Requested material has no visible text target")
                page.mouse.click(point["x"], point["y"])
                page.wait_for_timeout(500)
                entry["selected_material"] = selected_material
            elif material and material != "auto":
                raise RuntimeError("Requested material but no Material page appeared")
            if inspect_material:
                screenshot(page, f"{prefix}__before_add.png")
                candidates = page.evaluate("""() => Array.from(
                    document.querySelectorAll('button')).filter(b =>
                    /ADD TO BAG/i.test(b.innerText || '')).map(b => {
                    const r=b.getBoundingClientRect();
                    const x=r.x+r.width/2, y=r.y+r.height/2;
                    const hit=document.elementFromPoint(x,y);
                    return {text:b.innerText.trim().slice(0,100), x, y,
                      width:r.width, height:r.height, disabled:b.disabled,
                      aria_disabled:b.getAttribute('aria-disabled'),
                      in_viewport:x>innerWidth*.45 && x<innerWidth &&
                        y>70 && y<innerHeight-10 && r.width>70 && r.height>20,
                      hit:hit===b || b.contains(hit)};
                })""")
                entry["add_button_candidates"] = candidates
                on_screen = [b for b in candidates if b["in_viewport"] and b["hit"]
                             and not b["disabled"] and b["aria_disabled"] != "true"]
                if not on_screen:
                    raise RuntimeError("No clickable ADD TO BAG inside the right panel")
                chosen_button = max(on_screen, key=lambda b: b["y"])
                page.mouse.click(chosen_button["x"], chosen_button["y"])
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if "/cart" in page.url:
                        page.get_by_text("My Bag", exact=False).first.wait_for(timeout=15000)
                        page.locator(".el-loading-mask:visible").wait_for(
                            state="hidden", timeout=20000)
                        page.wait_for_timeout(1000)
                        break
                    if not entry.get("material_encountered") and page.get_by_text("Select Material", exact=True).is_visible():
                        break
                    page.wait_for_timeout(250)
                entry["stage_after_selection"] = "after ADD TO BAG"
            endpoint_text = dump_text(page, f"{prefix}.txt")
            screenshot(page, f"{prefix}.png")
            entry["evidence"] = {"text": str(output_path(f"{prefix}.txt").resolve()),
                                 "screenshot": str(output_path(f"{prefix}.png").resolve())}
            entry["observed_at"] = datetime.now().astimezone().isoformat()
            entry["page_headings"] = page.evaluate("""() =>
                Array.from(document.querySelectorAll('h1,h2,h3'))
                  .filter(e => { const r=e.getBoundingClientRect();
                    return r.width && r.height && r.x > innerWidth * .45; })
                  .map(e => e.innerText.trim()).filter(Boolean)
            """)
            material_heading = page.get_by_text("Select Material", exact=True)
            entry["material_visible"] = any(material_heading.nth(i).is_visible()
                                            for i in range(material_heading.count()))
            entry["page_url"] = page.url
            entry["cart_visible"] = "/cart" in page.url and page.get_by_text(
                "My Bag", exact=False).count() > 0
            entry["success"] = (entry["material_visible"] or entry["cart_visible"]
                                if inspect_material else True)
            if inspect_material and entry.get("selected_material"):
                entry["success"] = entry["cart_visible"]
            entry["reached_stage"] = ("Select Material" if entry["material_visible"]
                                      else "Cart" if entry["cart_visible"]
                                      else "Lens Technology")
            entry["price_text"] = endpoint_text[-12000:]
            if entry["material_visible"]:
                entry["material_status"] = "observed" if entry.get("material_options") else "observed_options_pending_parse"
            if entry["cart_visible"]:
                entry.update(parse_cart_item_prices(endpoint_text))
            if inspect_material and not entry["success"]:
                entry["error"] = "Neither Material nor Cart verified; inspect screenshot"
        except Exception as exc:
            entry.update(success=False, error=str(exc))
            try:
                error_prefix = f"{slugify(prescription)}__{slugify(lens_type)}__{slugify(option['name'])}__error"
                screenshot(page, error_prefix + ".png")
                dump_text(page, error_prefix + ".txt")
            except Exception:
                pass
        outcomes.append(entry)
    return outcomes


def click_panel_label(page, name):
    """Use an on-screen right-panel label, excluding off-canvas preview copies."""
    for attempt in range(5):
        accept_cookies_if_present(page)
        targets = page.evaluate(r"""name => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), rows=[];
            while (walker.nextNode()) {
                if ((walker.currentNode.nodeValue||'').replace(/\s+/g,' ').trim() !== name) continue;
                const el=walker.currentNode.parentElement, r=el.getBoundingClientRect();
                if (r.width && r.height && r.x > innerWidth*.45 && r.right < innerWidth)
                    rows.push({x:r.x+r.width/2,y:r.y+r.height/2});
            }
            return rows;
        }""", name)
        on_screen = [r for r in targets if 80 < r["y"] < 850]
        if on_screen:
            page.mouse.click(on_screen[0]["x"], on_screen[0]["y"])
            return True
        if not targets:
            return False
        page.mouse.move(1100, 600)
        page.mouse.wheel(0, 350 if targets[0]["y"] >= 850 else -350)
        page.wait_for_timeout(250)
    return False


def parse_cart_item_prices(text):
    """Parse one fresh-cart product block, never the coupon/order summary."""
    if "My Bag (1)" not in text or "Order Summary" not in text:
        return {"cart_price_status": "unavailable", "missing_reason": "Expected one cart item"}
    item = text.split("My Bag (1)", 1)[1].split("Order Summary", 1)[0]
    match = re.search(r"Frame:\s*(.*?)\$([\d,.]+)\s*Prescription\s*(.*?)"
                      r"Lenses\s*(.*?)\$([\d,.]+)\s*Subtotal\s*\$([\d,.]+)",
                      item, re.S)
    if not match:
        return {"cart_price_status": "unavailable", "missing_reason": "Cart item layout not recognized"}
    frame, lens, total = [Decimal(match.group(i).replace(',', '')) for i in (2, 5, 6)]
    if frame + lens != total:
        return {"cart_price_status": "ambiguous", "missing_reason": "Item total differs from frame plus lens"}
    return {"cart_price_status": "ok", "frame_price": str(frame),
            "lens_price": str(lens), "item_total_before_coupon": str(total),
            "currency": "USD", "lens_configuration_label": clean(match.group(4)),
            "frame_color": clean(match.group(1)),
            "cart_product_name": clean(item.split("Frame:", 1)[0]),
            "price_scope": "one cart item before coupon; tax and shipping not verified"}


def parse_material_options(text):
    if "Select Material" not in text:
        return []
    section = text.split("Select Material", 1)[1]
    options = []
    for name in ("MR™ Pro", "Standard Material"):
        match = re.search(re.escape(name) + r"\s*(?:\+\s*\$([\d,.]+)|(Free))", section)
        if match:
            options.append({"name": name, "additional_price":
                            str(Decimal(match.group(1).replace(',', ''))) if match.group(1) else "0.00",
                            "currency": "USD"})
    return options


# ============================================================
# 重新走到 Lens Type 页面
# ============================================================
def prepare_non_prescription_lens_types(page):

    reset_lens_flow(page)

    if not click_prescription_type(
        page,
        "Non-Prescription"
    ):
        raise RuntimeError(
            "Non-Prescription click failed"
        )

    print(
        "waiting for Lens Type page..."
    )

    # 不再 sleep 600ms
    # 必须真的等下一页出现
    ok = wait_for_text_visible(
        page,
        "Select A Lens Type",
        timeout=15000
    )

    if not ok:
        screenshot(
            page,
            "non_prescription_loading_failed.png"
        )

        dump_text(
            page,
            "non_prescription_loading_failed.txt"
        )

        raise RuntimeError(
            "Non-Prescription clicked, "
            "but Lens Type page did not finish loading"
        )

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and not inspect_lens_type_cards(page):
        page.wait_for_timeout(250)
    if not inspect_lens_type_cards(page):
        raise RuntimeError("Lens Type heading appeared, but cards did not load")

    print("Non-Prescription Lens Type page ready")

def prepare_single_vision_lens_types(page):

    reset_lens_flow(page)

    if not click_prescription_type(
        page,
        "Single Vision"
    ):
        raise RuntimeError(
            "Single Vision failed"
        )

    ok = wait_for_text_visible(
        page,
        "Enter Your Prescription",
        timeout=10000
    )

    if not ok:
        raise RuntimeError(
            "Prescription form not loaded"
        )

    fill = fill_single_vision_prescription(
        page
    )

    if not fill["success"]:
        raise RuntimeError(
            f"Fill failed: {fill}"
        )

    result = (
        submit_and_confirm_single_vision(
            page
        )
    )

    if not result["success"]:
        raise RuntimeError(
            f"Submit/confirm failed: {result}"
        )
# ============================================================
# 遍历某 Prescription 的 Lens Type
# ============================================================

def crawl_lens_types(page, prescription, focus=None, technology=None, child=None,
                     inspect_material=False, on_detail=None, material=None):

    if prescription == "Non-Prescription":

        prepare = (
            prepare_non_prescription_lens_types
        )

    elif prescription == "Single Vision":

        prepare = (
            prepare_single_vision_lens_types
        )

    else:

        raise ValueError(
            prescription
        )

    # 先进入一次，读取 Lens Type 列表
    prepare(
        page
    )

    screenshot(
        page,
        f"{slugify(prescription)}__lens_types.png"
    )

    initial_types = (
        parse_lens_type_cards(
            page
        )
    )

    print(
        "\nLens types:",
        json.dumps(
            initial_types,
            ensure_ascii=False,
            indent=2
        )
    )

    results = {
        "prescription": prescription,
        "lens_types": initial_types,
        "details": []
    }

    #
    # 每个 lens type 都重新开始流程
    # 防止点击后页面状态不可逆
    #
    candidates = [item for item in initial_types
                  if focus is None or item["name"] == focus]
    if focus and not candidates:
        raise RuntimeError(f"Lens Type not found: {focus}")
    for item_index, item in enumerate(candidates):

        lens_type = item["name"]

        print(
            "\n"
            "===================================="
        )

        print(
            prescription,
            "=>",
            lens_type
        )

        print(
            "===================================="
        )

        # 初次 prepare 已经到了镜片列表，单分支验证不重复导航。
        if item_index:
            prepare(page)

        ok = click_lens_type(
            page,
            lens_type
        )

        if not ok["clicked"]:

            failed = {
                "lens_type": lens_type,
                "success": False,
                "reason": "click failed or next page did not load",
                "action": ok["action"],
                "attempts": ok.get("attempts", [])
            }
            results["details"].append(failed)
            if on_detail:
                on_detail(prescription, initial_types, failed)

            continue

        detail = capture_lens_type_detail(
            page,
            prescription,
            lens_type
        )

        detail["success"] = True
        detail["action"] = ok["action"]
        detail["attempts"] = ok.get("attempts", [])
        if "section_lines" in ok:
            detail["section_lines"] = ok["section_lines"]

        if child and ok["action"] == "expanded":
            child_state = select_expanded_child(page, child)
            detail["child_selection"] = child_state
            if child_state["clicked"]:
                child_detail = capture_lens_type_detail(
                    page, prescription, f"{lens_type}__{child}")
                detail["child_lens_technology_options"] = child_detail[
                    "lens_technology_options"]
                detail["child_action"] = child_state["action"]
                if child_detail["lens_technology_options"]:
                    options = child_detail["lens_technology_options"]
                    selected = [o for o in options if o["name"] == technology] if technology else options[:1]
                    if selected:
                        detail["child_technology_observations"] = explore_lens_technology(
                            page, prescription, f"{lens_type}__{child}", selected,
                            prepare, inspect_material, material)

        if prescription == "Single Vision" and detail["lens_technology_options"]:
            options = detail["lens_technology_options"]
            if technology:
                options = [o for o in options if o["name"] == technology]
                if not options:
                    detail["technology_error"] = f"Not offered: {technology}"
            else:
                options = options[:1]
            if options:
                detail["technology_observations"] = explore_lens_technology(
                    page, prescription, lens_type, options, prepare, inspect_material, material)

        results["details"].append(
            detail
        )
        if on_detail:
            on_detail(prescription, initial_types, detail)

    return results


def probe_card_state(page, name):
    """记录卡片命中元素与按钮状态，用于排查页面没有响应的点击。"""
    rows = inspect_lens_type_cards(page)
    row = next((r for r in rows if r["name"] == name), None)
    if not row:
        return {"error": "card not found", "visible_cards": rows}
    box = row["card_box"]
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    dom = page.evaluate("""([x,y]) => {
        const el = document.elementFromPoint(x,y);
        let node = el, card = el;
        while (node && node !== document.body) {
            const r = node.getBoundingClientRect();
            if (r.width > 500 && r.height > 60 && r.height < 250) { card = node; break; }
            node = node.parentElement;
        }
        return {
            hit_tag: el?.tagName,
            hit_html: el?.outerHTML?.slice(0, 5000),
            card_html: card?.outerHTML?.slice(0, 15000),
            hit_pointer_events: el && getComputedStyle(el).pointerEvents,
            buttons: Array.from(document.querySelectorAll('button'))
              .filter(b => /^(NEXT|ADD TO BAG|BUY NOW)$/.test((b.innerText||'').trim()))
              .map(b => ({text:b.innerText.trim(), disabled:b.disabled,
                          class_name:b.className, outer_html:b.outerHTML.slice(0, 3000)}))
        };
    }""", [x, y])
    return {"name": name, "coordinates": {"x": x, "y": y},
            "card": row, "dom": dom,
            "visible_text_tail": page.locator("body").inner_text()[-3500:]}


def probe_standard_lenses():
    """只访问一个 Non-Prescription 分支，避免诊断时遍历十四次。"""
    events = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-US")
        page = context.new_page()
        page.on("response", lambda response: events.append({
            "status": response.status, "url": response.url[:500]
        }) if len(events) < 500 else None)
        try:
            prepare_non_prescription_lens_types(page)
            before = probe_card_state(page, "Standard Lenses")
            screenshot(page, "probe_before.png")
            if "coordinates" in before:
                coords = before["coordinates"]
                page.mouse.click(coords["x"], coords["y"])
                page.wait_for_timeout(5000)
            after = probe_card_state(page, "Standard Lenses")
            screenshot(page, "probe_after.png")
            save_json({"before": before, "after": after, "responses": events},
                      "probe_standard_lenses.json")
        finally:
            print("Probe output:", OUT_DIR.resolve())
            browser.close()


# ============================================================
# Main
# ============================================================

def load_master():
    if MASTER_PATH.exists():
        master = json.loads(MASTER_PATH.read_text(encoding="utf-8"))
        if master.get("product_url") != URL:
            raise ValueError("Product identity mismatch: refusing to reuse another product's cache")
        return master
    print("累计结果文件未放在脚本旁边，将从空结果开始:", MASTER_PATH)
    return {"schema_version": 1, "product_url": URL, "sources": [], "branches": {}}


def persist_master(master):
    temporary = MASTER_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(master, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(MASTER_PATH)
    print("updated cumulative result:", MASTER_PATH)


def merge_detail(master, prescription, lens_types, detail):
    branch = master.setdefault("branches", {}).setdefault(prescription, {})
    if lens_types:
        old_types = {item["name"]: item for item in branch.get("lens_types", [])}
        for item in lens_types:
            old_types.setdefault(item["name"], {}).update(
                {k: v for k, v in item.items() if v is not None})
        branch["lens_types"] = list(old_types.values())
    previous = branch.setdefault("details", {}).get(detail["lens_type"], {})
    result = deepcopy(previous)
    if detail.get("success"):
        for field in ("lens_type", "success", "action", "section_lines",
                      "lens_technology_options"):
            if field in detail and (detail[field] or field in ("success", "action")):
                result[field] = detail[field]
        new_observations = detail.get("technology_observations", [])
        existing = {item["technology"]: item for item in result.get(
            "technology_observations", [])}
        for observation in new_observations:
            preserve_observation(existing, observation)
        if new_observations:
            result["technology_observations"] = list(existing.values())
        child = detail.get("child_selection", {}).get("child")
        if child:
            children = result.setdefault("children", {})
            child_result = children.setdefault(child, {})
            if detail["child_selection"].get("clicked"):
                child_result["selection"] = detail["child_selection"]
            else:
                child_result["last_failed_selection"] = detail["child_selection"]
            if detail.get("child_lens_technology_options"):
                child_result["technology_options"] = detail["child_lens_technology_options"]
            if "child_technology_observations" in detail:
                old = {item["technology"]: item for item in child_result.get(
                    "technology_observations", [])}
                for observation in detail["child_technology_observations"]:
                    preserve_observation(old, observation)
                child_result["technology_observations"] = list(old.values())
    else:
        result["last_attempt"] = {k: detail.get(k) for k in
                                  ("reason", "action", "attempts")}
    result["last_checked_script_version"] = SCRIPT_VERSION
    branch["details"][detail["lens_type"]] = result
    source = {"run": OUT_DIR.name, "script_version": SCRIPT_VERSION,
              "evidence_dir": str(OUT_DIR.resolve())}
    if source not in master.setdefault("sources", []):
        master["sources"].append(source)
    persist_master(master)


def preserve_observation(existing, observation):
    key = observation["technology"]
    previous = existing.get(key)
    if previous:
        previous_complete = (previous.get("success") and previous.get("reached_stage") == "Cart"
                             and previous.get("item_total_before_coupon") is not None)
        current_complete = (observation.get("success") and observation.get("reached_stage") == "Cart"
                            and observation.get("item_total_before_coupon") is not None)
        if previous_complete and not current_complete:
            previous.setdefault("incomplete_attempts", []).append(deepcopy(observation))
            return
        if previous.get("success") and not observation.get("success"):
            previous.setdefault("failed_attempts", []).append(deepcopy(observation))
            return
        observation = deepcopy(observation)
        observation["history"] = previous.get("history", []) + [
            {k: v for k, v in previous.items() if k not in ("history", "material_variants")}]
    variants = deepcopy((previous or {}).get("material_variants", {}))
    if observation.get("success") and observation.get("selected_material"):
        variants[observation["selected_material"]["name"]] = {
            k: deepcopy(v) for k, v in observation.items() if k not in ("history", "material_variants")}
    if variants:
        observation["material_variants"] = variants
    existing[key] = observation


def main():
    parser = argparse.ArgumentParser(description="增量采集 Vooglam 镜片价格")
    parser.add_argument("--url", default=URL)
    parser.add_argument("--branch", choices=("Single Vision", "Non-Prescription"),
                        default="Single Vision")
    parser.add_argument("--lens-type", default="Photochromic")
    parser.add_argument("--child", default="Standard Photochromic")
    parser.add_argument("--technology", default=None)
    parser.add_argument("--material", choices=("Standard Material", "MR™ Pro", "auto"), default=None,
                        help="出现 Material 时选择指定材料；未指定则只采集材料选项")
    parser.add_argument("--all", action="store_true", help="明确要求时才遍历两个分支")
    parser.add_argument("--channel", choices=("chrome", "msedge"), default=None)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--non-interactive", action="store_true")
    parser.add_argument("--no-inspect-material", action="store_true",
                        help="选择技术后不点击 ADD TO BAG")
    args = parser.parse_args()
    configure_product(args.url)
    print("Vooglam lens tree script:", SCRIPT_VERSION)
    master = load_master()
    results = {"script_version": SCRIPT_VERSION,
               "mode": "all" if args.all else "focused",
               "cumulative_file": str(MASTER_PATH)}
    branches = ("Non-Prescription", "Single Vision") if args.all else (args.branch,)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=args.headless, channel=args.channel)
        context = browser.new_context(viewport={"width": 1440, "height": 1000},
                                      locale="en-US")
        page = context.new_page()
        for prescription in branches:
            print("\nCRAWL:", prescription,
                  "all lens types" if args.all else args.lens_type)
            try:
                data = crawl_lens_types(
                    page, prescription,
                    focus=None if args.all else args.lens_type,
                    technology=None if args.all else args.technology,
                    child=None if args.all else args.child,
                    material=None if args.all else args.material,
                    inspect_material=not args.all and not args.no_inspect_material,
                    on_detail=lambda name, types, detail: merge_detail(
                        master, name, types, detail))
                results[slugify(prescription)] = data
            except Exception as exc:
                results[slugify(prescription)] = {"success": False, "error": str(exc)}
                print("Branch error:", exc)
        save_json(results, "final_result.json")
        print("\nDONE. New run:", OUT_DIR.resolve())
        print("Cumulative:", MASTER_PATH)
        if not args.non_interactive:
            input("\n检查浏览器和输出文件，按 Enter 退出...")
        browser.close()


if __name__ == "__main__":
    if "--probe" in sys.argv:
        probe_standard_lenses()
    else:
        main()
