// ============================================================================
// The script that runs on the MERCHANT'S storefront.
//
// Kept as a template string in its own file so it can be read and edited like
// code rather than buried in a route handler. `__CONFIG__` is replaced with the
// shop's settings when it is served.
//
// Rules it lives by, because it runs on someone else's site:
//   - No dependencies, no framework, no globals beyond one guard flag.
//   - Everything scoped under one class prefix so it cannot collide with the
//     theme's CSS, and the panel is appended to <body> so it cannot inherit a
//     parent's transform or overflow.
//   - It never blocks the page: no synchronous work, no layout thrash on scroll.
//   - It fails silently. A storefront must not show a stranger our errors.
//   - It respects prefers-reduced-motion and closes on Escape, because it is a
//     modal and the people who need that are the people least able to fight it.
// ============================================================================

const POPUP_SCRIPT = `(function(){
  "use strict";
  if (window.__saPopup) return; window.__saPopup = true;
  var C = __CONFIG__;
  if (!C || !C.shop) return;

  var KEY = "sa_popup_" + C.shop;
  function seenRecently() {
    if (!C.freqDays) return false;
    try {
      var v = localStorage.getItem(KEY);
      if (!v) return false;
      if (v === "done") return true;            // already subscribed: never again
      return (Date.now() - Number(v)) < C.freqDays * 86400000;
    } catch (e) { return false; }               // private mode: show it, once
  }
  function remember(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  var reduce = false;
  try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  function css() {
    var s = document.createElement("style");
    s.textContent = [
      ".sa-pop-wrap{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;",
        "justify-content:center;background:rgba(20,22,26,.55);padding:16px;",
        "opacity:0;transition:opacity .22s ease}",
      ".sa-pop-wrap.sa-in{opacity:1}",
      "@media (prefers-reduced-motion: reduce){.sa-pop-wrap{transition:none}}",
      ".sa-pop{background:#fff;color:#16181d;max-width:760px;width:100%;display:flex;",
        "box-shadow:0 24px 70px rgba(0,0,0,.3);position:relative;max-height:92vh;overflow:auto;",
        "font-family:inherit;direction:" , (C.rtl ? "rtl" : "ltr"), "}",
      ".sa-pop-img{width:45%;background-size:cover;background-position:center;flex:none}",
      ".sa-pop-body{flex:1;padding:38px 34px;text-align:center}",
      ".sa-pop h2{font-size:26px;line-height:1.2;margin:0 0 12px;font-weight:800}",
      ".sa-pop p.sa-sub{font-size:14.5px;line-height:1.6;margin:0 0 6px;color:#4b5563}",
      ".sa-pop .sa-inc{display:inline-block;margin:8px 0 4px;font-weight:700;font-size:15px}",
      ".sa-pop input[type=email]{width:100%;box-sizing:border-box;margin-top:18px;padding:13px 14px;",
        "border:1px solid #c9ced6;border-radius:2px;font-size:15px;text-align:center;font-family:inherit;color:#16181d;background:#fff}",
      ".sa-pop input[type=email]:focus{outline:2px solid #16181d;outline-offset:1px}",
      ".sa-pop .sa-genders{display:flex;gap:22px;justify-content:center;margin-top:16px;font-size:14px}",
      ".sa-pop .sa-genders label{display:flex;align-items:center;gap:6px;cursor:pointer}",
      ".sa-pop .sa-consent{display:flex;gap:8px;align-items:flex-start;margin-top:16px;font-size:12.5px;",
        "line-height:1.5;text-align:", (C.rtl ? "right" : "left"), ";color:#4b5563}",
      ".sa-pop .sa-consent input{margin-top:2px;flex:none}",
      ".sa-pop button.sa-go{margin-top:20px;width:100%;padding:14px;border:0;background:#16181d;color:#fff;",
        "font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;font-family:inherit}",
      ".sa-pop button.sa-go:disabled{opacity:.55;cursor:default}",
      ".sa-pop .sa-x{position:absolute;top:10px;", (C.rtl ? "left" : "right"), ":12px;background:none;border:0;",
        "font-size:24px;line-height:1;color:#6b7280;cursor:pointer;padding:6px}",
      ".sa-pop .sa-msg{margin-top:14px;font-size:13.5px;min-height:18px}",
      ".sa-pop .sa-msg.sa-err{color:#b4342c}",
      ".sa-pop .sa-hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}",
      ".sa-pop .sa-code{display:inline-block;margin-top:12px;padding:10px 18px;background:#f2f5ff;",
        "color:#0a4fd0;font-weight:800;letter-spacing:1px;border-radius:3px}",
      "@media (max-width:640px){.sa-pop-img{display:none}.sa-pop-body{padding:32px 22px}.sa-pop h2{font-size:22px}}"
    ].join("");
    document.head.appendChild(s);
  }

  function build() {
    var wrap = document.createElement("div");
    wrap.className = "sa-pop-wrap";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", C.t.headline);

    var pop = document.createElement("div");
    pop.className = "sa-pop";

    if (C.image) {
      var img = document.createElement("div");
      img.className = "sa-pop-img";
      img.style.backgroundImage = "url(" + JSON.stringify(C.image).slice(1, -1) + ")";
      pop.appendChild(img);
    }

    var body = document.createElement("div");
    body.className = "sa-pop-body";
    pop.appendChild(body);

    var x = document.createElement("button");
    x.className = "sa-x"; x.type = "button";
    x.setAttribute("aria-label", C.t.close);
    x.innerHTML = "&times;";
    pop.appendChild(x);

    var h = document.createElement("h2"); h.textContent = C.t.headline; body.appendChild(h);
    var sub = document.createElement("p"); sub.className = "sa-sub"; sub.textContent = C.t.subhead; body.appendChild(sub);
    if (C.incentive) {
      var inc = document.createElement("div"); inc.className = "sa-inc"; inc.textContent = C.incentive;
      body.appendChild(inc);
    }

    var email = document.createElement("input");
    email.type = "email"; email.placeholder = C.t.email_ph; email.autocomplete = "email";
    email.setAttribute("aria-label", C.t.email_ph);
    body.appendChild(email);

    // Decoy. Off-screen and never announced, so a person never meets it.
    var hp = document.createElement("input");
    hp.type = "text"; hp.className = "sa-hp"; hp.name = "company";
    hp.tabIndex = -1; hp.setAttribute("aria-hidden", "true"); hp.autocomplete = "off";
    body.appendChild(hp);

    var gender = null;
    if (C.askGender) {
      var g = document.createElement("div"); g.className = "sa-genders";
      ["woman", "man"].forEach(function (val) {
        var lab = document.createElement("label");
        var rb = document.createElement("input");
        rb.type = "radio"; rb.name = "sa_gender"; rb.value = val;
        rb.addEventListener("change", function () { gender = val; });
        lab.appendChild(rb);
        lab.appendChild(document.createTextNode(C.t[val]));
        g.appendChild(lab);
      });
      body.appendChild(g);
    }

    var cons = document.createElement("label"); cons.className = "sa-consent";
    var cb = document.createElement("input"); cb.type = "checkbox";
    cons.appendChild(cb);
    cons.appendChild(document.createTextNode(C.t.consent));
    body.appendChild(cons);

    var go = document.createElement("button");
    go.className = "sa-go"; go.type = "button"; go.textContent = C.t.button;
    body.appendChild(go);

    var msg = document.createElement("div"); msg.className = "sa-msg"; body.appendChild(msg);

    wrap.appendChild(pop);
    return { wrap: wrap, pop: pop, email: email, hp: hp, cb: cb, go: go, msg: msg,
             close: x, getGender: function () { return gender; }, body: body };
  }

  function show() {
    css();
    var el = build();
    document.body.appendChild(el.wrap);
    requestAnimationFrame(function () { el.wrap.classList.add("sa-in"); });
    remember(String(Date.now()));

    var lastFocus = document.activeElement;
    setTimeout(function () { try { el.email.focus(); } catch (e) {} }, reduce ? 0 : 220);

    function close() {
      el.wrap.classList.remove("sa-in");
      setTimeout(function () { try { el.wrap.remove(); } catch (e) {} }, reduce ? 0 : 220);
      document.removeEventListener("keydown", onKey);
      try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    el.close.addEventListener("click", close);
    el.wrap.addEventListener("click", function (e) { if (e.target === el.wrap) close(); });

    el.go.addEventListener("click", function () {
      var addr = (el.email.value || "").trim();
      el.msg.className = "sa-msg";
      if (!addr || addr.indexOf("@") < 1 || addr.indexOf(".", addr.indexOf("@")) < 0) {
        el.msg.className = "sa-msg sa-err"; el.msg.textContent = C.t.invalid; el.email.focus(); return;
      }
      if (!el.cb.checked) {
        el.msg.className = "sa-msg sa-err"; el.msg.textContent = C.t.consent; el.cb.focus(); return;
      }
      el.go.disabled = true;
      fetch(C.base + "/api/public/popup/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: C.shop, email: addr, gender: el.getGender(),
          company: el.hp.value || null,
          consent_text: C.t.consent,
          source_url: location.href.slice(0, 400)
        })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.ok) {
          el.go.disabled = false;
          el.msg.className = "sa-msg sa-err";
          el.msg.textContent = (d && d.error === "invalid_email") ? C.t.invalid : C.t.failed;
          return;
        }
        remember("done");
        el.body.innerHTML = "";
        var h2 = document.createElement("h2");
        h2.textContent = (d.status === "pending") ? C.t.pending : C.t.success;
        el.body.appendChild(h2);
        if (d.discount_code) {
          var code = document.createElement("div");
          code.className = "sa-code"; code.textContent = d.discount_code;
          el.body.appendChild(code);
        }
        setTimeout(close, 4200);
      }).catch(function () {
        el.go.disabled = false;
        el.msg.className = "sa-msg sa-err"; el.msg.textContent = C.t.failed;
      });
    });

    el.email.addEventListener("keydown", function (e) { if (e.key === "Enter") el.go.click(); });
  }

  function arm() {
    if (seenRecently()) return;
    var fired = false;
    function fire() { if (fired) return; fired = true; cleanup(); show(); }
    function onScroll() {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      if (h <= 0) return;
      if ((window.scrollY / h) * 100 >= C.scrollPct) fire();
    }
    function cleanup() {
      window.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    }
    var timer = null;
    if (C.scrollPct > 0) window.addEventListener("scroll", onScroll, { passive: true });
    // Time is always a trigger; scroll only brings it forward.
    timer = setTimeout(fire, C.delay);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", arm);
  } else { arm(); }
})();`;

module.exports = { POPUP_SCRIPT };
