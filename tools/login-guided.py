#!/usr/bin/env python3
"""在**有可见窗口**的机器上扫码登录抖音，并每 5 秒截图方便照着操作。

用法::

    # 第一个参数是 dsh-douyin 的本地根目录（会复用它自己的浏览器发现与 cookie 路径）
    python tools/login-guided.py ~/dsh-douyin 600

和上游 ``dsh-douyin/tools/export_login_state.py`` 的区别：

- 抖音首页**不会**自动弹二维码，本脚本会自动点右上角「登录」（最多 3 次）；
- 每 5 秒把页面截到 ``/tmp/dy-login.png``，方便人（或另一个 agent）确认当前卡在哪一步；
- 登录判定与输出文件沿用上游约定：``<dsh-douyin>/data/home/.dy/cookies/default.json``。

WSL 提示：WSLg 下窗口会出现在 Windows 桌面；若找不到窗口，直接打开截图文件扫码。
"""
from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import time


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: login-guided.py <dsh-douyin 根目录> [超时秒数]", file=sys.stderr)
        return 2
    root = os.path.abspath(os.path.expanduser(sys.argv[1]))
    timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 600
    if not os.path.isdir(root):
        print("不存在目录: " + root, file=sys.stderr)
        return 2

    sys.path.insert(0, os.path.join(root, "tools"))
    sys.path.insert(0, os.path.join(root, "python"))

    import export_login_state as E  # 复用上游的登录判定与默认浏览器
    from playwright.async_api import async_playwright

    out = os.path.join(root, "data/home/.dy/cookies/default.json")
    shot = "/tmp/dy-login.png"
    os.makedirs(os.path.dirname(out), exist_ok=True)

    async def run() -> int:
        exe = E.D.CHROME
        if not exe:
            print("找不到浏览器：请先 `playwright install chromium`，或用 DOUYIN_BROWSER 指定", file=sys.stderr)
            return 1
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                executable_path=exe,
                headless=False,
                args=["--no-first-run", "--disable-blink-features=AutomationControlled",
                      "--start-maximized", "--window-position=120,60"],
            )
            context = await browser.new_context(
                viewport={"width": 1360, "height": 900}, locale="zh-CN", user_agent=E.D.UA,
            )
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(E.LOGIN_URL, wait_until="domcontentloaded", timeout=60_000)

            print("窗口已打开，等待登录（最多 %d 秒）" % timeout, flush=True)
            deadline = time.monotonic() + timeout
            how = ""
            tick = 0
            clicked = 0

            async def open_login() -> None:
                nonlocal clicked
                if clicked >= 3:
                    return
                clicked += 1
                for locator in (page.get_by_role("button", name="登录"),
                                page.locator("button:has-text('登录')"),
                                page.locator("text=登录").first):
                    try:
                        if await locator.count() > 0:
                            await locator.first.click(timeout=4_000)
                            await page.wait_for_timeout(2_000)
                            print("已点击「登录」，等待二维码", flush=True)
                            return
                    except Exception:
                        continue

            while time.monotonic() < deadline:
                try:
                    how = await page.evaluate(E.LOGGED_IN_JS)
                except Exception:
                    how = ""
                if not how:
                    try:
                        if E.cookies_have_session(await context.cookies()):
                            how = "sessionid cookie"
                    except Exception:
                        pass
                if how:
                    break
                tick += 1
                if tick in (1, 5, 15, 40):
                    await open_login()
                try:
                    await page.screenshot(path=shot)
                except Exception:
                    pass
                if tick % 6 == 0:
                    print("仍在等待登录（已 %d 秒）" % (tick * 5), flush=True)
                await page.wait_for_timeout(5_000)

            if not how:
                print("超时：没有检测到登录态", file=sys.stderr, flush=True)
                try:
                    await page.screenshot(path=shot)
                except Exception:
                    pass
                await context.close()
                return 1

            await page.wait_for_timeout(2_500)
            state = await context.storage_state()
            with open(out, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
            try:
                os.chmod(out, stat.S_IRUSR | stat.S_IWUSR)
            except OSError:
                pass
            print("登录成功：%s｜cookie 条数：%d｜文件：%s"
                  % (how, len(state.get("cookies") or []), out), flush=True)
            await context.close()
        return 0

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
