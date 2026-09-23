"""向 project.config.json 的 packOptions.ignore 追加 TDesign 未使用组件忽略项（不删除任何文件）"""
import json, os

ROOT = r"E:\WeChatProjects\zhuanzhuo-miniapp"
PCFG = os.path.join(ROOT, "project.config.json")
TD = "miniprogram_npm/tdesign-miniprogram"

KEEP = {
    "button", "loading", "empty", "tag", "toast", "qrcode", "popup",
    "icon", "overlay", "image", "common", "mixins",
}
unused = [
    "action-sheet", "attachments", "avatar", "avatar-group", "back-top", "badge",
    "calendar", "cascader", "cell", "cell-group", "chat-actionbar", "chat-content",
    "chat-list", "chat-loading", "chat-markdown", "chat-message", "chat-record",
    "chat-sender", "chat-thinking", "check-tag", "checkbox", "checkbox-group",
    "col", "collapse", "collapse-panel", "color-picker", "config-provider",
    "count-down", "date-time-picker", "dialog", "divider", "drawer",
    "dropdown-item", "dropdown-menu", "fab", "footer", "form", "form-item",
    "grid", "grid-item", "guide", "image-viewer", "indexes", "indexes-anchor",
    "input", "link", "locale", "message", "message-item", "miniprogram_npm",
    "navbar", "notice-bar", "paragraph", "picker", "picker-item", "popover",
    "progress", "pull-down-refresh", "radio", "radio-group", "rate", "result",
    "row", "scroll-view", "search", "segmented", "side-bar", "side-bar-item",
    "skeleton", "slider", "step-item", "stepper", "steps", "sticky",
    "swipe-cell", "swiper", "swiper-nav", "switch", "tab-bar", "tab-bar-item",
    "tab-panel", "table", "tabs", "text", "textarea", "title", "transition",
    "tree-select", "upload", "watermark",
]

with open(PCFG, encoding="utf-8") as f:
    cfg = json.load(f)

ignore = cfg.setdefault("packOptions", {}).setdefault("ignore", [])
existing = {(e.get("type"), e.get("value")) for e in ignore}

added = 0
for name in unused:
    for base in (TD, "miniprogram/" + TD):  # 两种相对基准都写，保证命中
        key = ("folder", f"{base}/{name}")
        if key not in existing:
            ignore.append({"type": "folder", "value": key[1]})
            existing.add(key)
            added += 1
# tdesign 根目录下的 IDE 元数据
for key in [("file", f"{TD}/.wechatide.ib.json"), ("file", f"miniprogram/{TD}/.wechatide.ib.json")]:
    if key not in existing:
        ignore.append({"type": "file", "value": key[1]})
        existing.add(key)
        added += 1

with open(PCFG, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)

print(f"added {added} ignore entries, total {len(ignore)}")
