/**
 * dy-whale 客户端半边：DSH「设置 → 抖音」里的扫码登录卡片。
 *
 * 数据流：section ⇄ `/dy-whale/api/douyin*`（同源 fetch，过 DSH 信任栅栏）
 *   GET  /dy-whale/api/douyin          当前阶段 + 二维码（data URL）+ 今日计划
 *   POST /dy-whale/api/douyin/start    启动登录守护（dsh-douyin 的 login-daemon）
 *   POST /dy-whale/api/douyin/cancel   取消登录
 *   POST /dy-whale/api/douyin/submit   { codes } 提交短信验证码
 *
 * 平台事实：抖音的二维码不是接口返回的数据，而是登录页渲染出来的；
 * 宿主每 4 秒截一次图并裁出二维码，这里只负责显示与轮询。
 */
window.__ModuleLoader__.load({
  id: "dy-whale",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = "/dy-whale/api/douyin";
    const ACTIVE = ["qrcode", "challenge_required", "sms_verification", "sms_code_input"];
    const PHASE_TEXT = {
      idle: "未连接",
      qrcode: "等待扫码",
      sms_verification: "短信登录：请输入手机号",
      sms_code_input: "短信登录：请输入验证码",
      challenge_required: "需要人工完成安全验证",
      logged_in: "已登录",
      expired: "二维码已过期",
      failed: "登录失败",
      stopped: "已取消登录",
    };

    const S = {
      wrap: { maxWidth: 760, display: "flex", flexDirection: "column", gap: 10, color: "var(--dsw-alias-label-primary)" },
      title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "24px" },
      intro: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
      group: { marginTop: 8, fontSize: 13, fontWeight: 600, lineHeight: "20px" },
      row: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, padding: "10px 0", borderBottom: ".5px solid var(--dsw-alias-border-l2)" },
      label: { fontSize: 13, lineHeight: "19px" },
      hint: { marginTop: 3, fontSize: 11.5, lineHeight: "17px", color: "var(--dsw-alias-label-tertiary)" },
      card: { display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap", padding: "12px 0" },
      qr: { width: 220, height: 220, borderRadius: 8, background: "#fff", padding: 6, boxShadow: "0 0 0 1px var(--dsw-alias-border-l2)" },
      full: { width: "100%", maxWidth: 640, borderRadius: 8, boxShadow: "0 0 0 1px var(--dsw-alias-border-l2)" },
      btn: { height: 30, padding: "0 14px", borderRadius: 6, border: "none", background: "var(--dsw-alias-brand-primary, #d94a4a)", color: "#fff", fontSize: 13, cursor: "pointer" },
      btn2: { height: 30, padding: "0 14px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-primary)", fontSize: 13, cursor: "pointer" },
      err: { fontSize: 12.5, color: "#e5484d", lineHeight: "18px", whiteSpace: "pre-wrap" },
      ok: { fontSize: 12.5, color: "var(--dsw-alias-label-secondary)", lineHeight: "18px" },
      input: { height: 28, minWidth: 160, padding: "0 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-primary)", fontSize: 13 },
    };

    const fmt = (iso) => {
      if (!iso) return "—";
      try {
        const d = new Date(iso);
        return d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      } catch { return String(iso); }
    };

    function DySection() {
      const [state, setState] = useState(null);
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState("");
      const [showFull, setShowFull] = useState(false);
      const [codes, setCodes] = useState("");
      const [confirmReset, setConfirmReset] = useState(false);
      const alive = useRef(true);

      const load = useCallback(async () => {
        try {
          const r = await fetch(API, { headers: { accept: "application/json" } });
          if (!r.ok) {
            // 401 是 DSH 的登录栅栏；404/503 是插件没挂上
            if (alive.current) setErr(r.status === 401 ? "需要重新加载页面（登录态已过期）" : "接口返回 " + r.status);
            return;
          }
          const data = await r.json();
          if (alive.current) { setState(data); setErr(""); }
        } catch (e) {
          if (alive.current) setErr(String((e && e.message) || e));
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        load();
        const t = setInterval(load, 2000);
        return () => { alive.current = false; clearInterval(t); };
      }, [load]);

      const act = async (action, body) => {
        setBusy(action);
        setErr("");
        try {
          const r = await fetch(API + "/" + action, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || data.ok === false) setErr(data.error || "操作失败：" + r.status);
          await load();
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy("");
        }
      };

      if (!state) {
        return h("div", { style: S.wrap }, h("h2", { style: S.title }, "抖音"), err ? h("div", { style: S.err }, err) : h("div", { style: S.hint }, "读取中…"));
      }

      const phase = state.phase || "idle";
      const active = ACTIVE.indexOf(phase) >= 0 && !!state.qr;
      const loggedIn = !!state.cookiePresent || phase === "logged_in";
      const plan = state.plan || null;
      const planText = plan && plan.atMs
        ? (new Date(plan.atMs).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
          + (plan.skip ? "（掷到不想看）" : "") + (plan.fired ? "（已醒过）" : ""))
        : "今天没有可用窗口";

      const rows = [
        ["账号状态", loggedIn
          ? ("已连接" + (state.nickname ? "：" + state.nickname : "") + (state.cookiePresent ? "（登录态已保存）" : ""))
          : (PHASE_TEXT[phase] || phase)],
        ["今日计划", planText],
      ];

      return h("div", { style: S.wrap },
        h("h2", { style: S.title }, "抖音"),
        h("p", { style: S.intro }, "给这条鱼连接抖音账号。扫码由 dsh-douyin 的登录守护完成：它会在后台打开登录页并定时截图，这里显示裁出来的二维码。"),

        ...rows.map(([k, v]) => h("div", { style: S.row, key: k },
          h("div", null, h("div", { style: S.label }, k), h("div", { style: S.hint }, String(v))))),

        phase === "challenge_required"
          ? h("div", { style: S.err }, "抖音要求人工完成安全验证（滑块/验证码）。本机是后台浏览器，无法自动通过；请改用手机抖音 App 扫码，或稍后重试。")
          : null,

        h("div", { style: S.card },
          active
            ? h("div", null,
              h("img", { src: showFull ? state.full : state.qr, style: showFull ? S.full : S.qr, alt: "抖音登录二维码" }),
              h("div", { style: S.hint }, showFull ? "完整登录页截图" : "用抖音 App 扫码登录（约几分钟有效）"))
            : null,
          h("div", { style: { display: "flex", flexDirection: "column", gap: 8, minWidth: 220 } },
            h("div", null,
              h("button", {
                style: S.btn,
                disabled: !!busy || active || !state.configured,
                onClick: () => act("start"),
              }, busy === "start" ? "正在打开登录页…" : (loggedIn ? "重新登录" : "连接抖音账号")),
              h("button", {
                style: { ...S.btn2, marginLeft: 8 },
                disabled: !!busy || !active,
                onClick: () => act("cancel"),
              }, busy === "cancel" ? "取消中…" : "取消登录")),
            active
              ? h("div", null, h("button", { style: S.btn2, onClick: () => setShowFull((v) => !v) }, showFull ? "只看二维码" : "查看完整截图"))
              : null,
            loggedIn
              ? (confirmReset
                ? h("div", { style: { display: "flex", gap: 8 } },
                  h("button", {
                    style: S.btn2,
                    disabled: !!busy,
                    onClick: () => act("reset").then(() => setConfirmReset(false)),
                  }, busy === "reset" ? "清除中…" : "确认清除（保留 .bak 备份）"),
                  h("button", { style: S.btn2, onClick: () => setConfirmReset(false) }, "算了"))
                : h("button", { style: S.btn2, onClick: () => setConfirmReset(true) }, "换号／清除登录态"))
              : null,
            h("div", { style: S.hint }, !state.configured
              ? "还没有配置 douyinRepo：在 ~/.dsh/dy-whale.config.json 里填 dsh-douyin 的本地目录。"
              : (loggedIn ? "已连接；想换号或重新扫码，先点「换号／清除登录态」再点「连接抖音账号」。" : "点「连接抖音账号」后，等待二维码出现。")),
            (phase === "sms_verification" || phase === "sms_code_input")
              ? h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                h("input", { style: S.input, placeholder: "短信验证码", value: codes, onChange: (e) => setCodes(e.target.value) }),
                h("button", { style: S.btn2, disabled: !!busy, onClick: () => act("submit", { codes }) }, "提交"))
              : null,
            h("div", { style: S.hint }, "登录成功后会写入 dsh-douyin 的 cookie 与浏览器 profile，无需再手动导出。"))),

        err ? h("div", { style: S.err }, err) : null,
        h("div", { style: S.ok }, "提示：设置页显示的是后台截图；如果抖音弹了安全验证，扫码可能失败，稍后重试即可。"),
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject("settings.section", () => ctx.slots.register(
          { name: "settings.section", id: "dy-whale", order: 7, label: () => "抖音" },
          DySection,
        ), "dy-whale: settings section"),
        "dy-whale: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.DySection = DySection;
    return module.exports;
  },
});
