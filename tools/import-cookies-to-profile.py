#!/usr/bin/env python3
"""把已导出的登录态灌进 dsh-douyin 浏览器桥的持久化 profile。

为什么需要：``dsh-douyin`` 有**两份**登录态——

- ``dy-cli``（HTTP 反向接口：热榜/搜索）读 ``data/home/.dy/cookies/default.json``
- 浏览器桥（截获签名 XHR：视频详情/评论/私信）读它自己的 profile ``data/browser-profile``

只导出 cookie 文件时，视频详情与评论会因为桥仍是游客态而读不到。
本脚本把同一份 cookie + localStorage 注入 profile，避免二次扫码。

用法::

    python tools/import-cookies-to-profile.py ~/dsh-douyin
"""
from __future__ import annotations

import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: import-cookies-to-profile.py <dsh-douyin 根目录>", file=sys.stderr)
        return 2
    root = os.path.abspath(os.path.expanduser(sys.argv[1]))
    if not os.path.isdir(root):
        print("不存在目录: " + root, file=sys.stderr)
        return 2

    sys.path.insert(0, os.path.join(root, "python"))
    import douyin_bridge as B  # 复用它的浏览器发现与 profile 路径约定

    cookie_file = os.path.join(root, "data/home/.dy/cookies/default.json")
    profile = os.path.join(root, "data/browser-profile")
    if not os.path.isfile(cookie_file):
        print("缺少 cookie 文件：%s（先跑 login-guided.py）" % cookie_file, file=sys.stderr)
        return 2

    state = json.load(open(cookie_file, encoding="utf-8"))
    cookies = []
    for c in state.get("cookies") or []:
        item = {"name": c["name"], "value": c["value"], "domain": c["domain"],
                "path": c.get("path", "/"), "secure": bool(c.get("secure")),
                "httpOnly": bool(c.get("httpOnly"))}
        if c.get("expires", -1) and c["expires"] > 0:
            item["expires"] = c["expires"]
        cookies.append(item)

    exe = B.edge_path()
    if not exe:
        print("找不到浏览器", file=sys.stderr)
        return 1
    print("浏览器:", exe)
    print("cookie 条数:", len(cookies))

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            profile, executable_path=exe, headless=True,
            args=["--no-first-run", "--no-default-browser-check",
                  "--disable-blink-features=AutomationControlled", "--lang=zh-CN"],
            viewport={"width": 1280, "height": 900}, locale="zh-CN",
        )
        ctx.add_cookies(cookies)
        for origin in state.get("origins") or []:
            page = ctx.new_page()
            try:
                page.goto(origin["origin"], wait_until="domcontentloaded", timeout=30_000)
                items = [[i["name"], i["value"]] for i in origin.get("localStorage") or []]
                if items:
                    page.evaluate("(pairs) => { for (const [k, v] of pairs) localStorage.setItem(k, v) }", items)
            except Exception as exc:
                print("localStorage 注入失败:", origin.get("origin"), exc)
            finally:
                page.close()
        ctx.close()
    print("已注入 profile:", profile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
