"use strict";
/*
 * ES-5XP web.
 *
 * The page edits keys of the vendor configuration (/tmp/system.cfg) and asks cgi-bin/api to apply
 * them the vendor way (rc.softrestart). It keeps a list of pending edits (key -> value, or null
 * for "delete the key") over the configuration it last read; Apply sends exactly that list.
 * Every value is checked again by the CGI against its whitelist - the checks here only help.
 *
 * Key forms follow what the vendor web writes (captured 2026-10-02, cap3/cap3b): settings at their
 * default are left absent where the vendor leaves them absent; a key already present is rewritten
 * explicitly. Address and VLAN changes go as a trial apply (not written to flash); the page
 * confirms by itself once it can still reach the switch, otherwise the switch reboots into the
 * saved configuration after 5 minutes.
 */

var PORTS = [1, 2, 3, 4, 5];
var TEST_KEYS = /^(switch\.vlan\.|dhcpc\.|netconf\.|route\.|resolv\.nameserver|switch\.managementvlan)/;
var TEST_SEC = 300;
var S = {
  cfg: {}, edits: {}, bad: {}, info: null, ports: null, fdb: null, page: "",
  auto: null, follow: null, reach: 0, newUrl: "", deadline: 0,
  mirT: null, out: {}, fw: null, showDiff: false, loaded: false,
  tool: { t: "ping", h: "", c: "4", out: "" }, arp: null, toolsStamp: ""
};

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function pk(p, r) { return "switch.port." + p + "." + r; }
function sk(p, r) { return "switch.rstp.port." + p + "." + r; }
function qk(p, r) { return "qos.port." + p + "." + r; }
function vk(v, r) { return "switch.vlan." + v + "." + r; }

/* ------------------------------------------------------------------ API */
function api(a, opt) {
  opt = opt || {};
  var url = "cgi-bin/api?a=" + a + (opt.q ? "&" + opt.q : "");
  var init = { cache: "no-store", credentials: "same-origin" };
  if (opt.body !== undefined) {
    init.method = "POST";
    init.headers = { "X-ES5XP": "1", "Content-Type": opt.type || "text/plain" };
    init.body = opt.body;
  }
  if (opt.timeout && window.AbortController) {   /* a hanging request is given up; the caller repeats it */
    var ac = new AbortController(); init.signal = ac.signal;
    setTimeout(function () { ac.abort(); }, opt.timeout);
  }
  return fetch(url, init).then(function (r) {
    return r.text().then(function (t) {
      if (!r.ok) throw new Error(t.trim() || ("HTTP " + r.status));
      return opt.json ? JSON.parse(t) : t;
    });
  });
}
function upload(a, file, onprog) {   /* XHR: fetch has no upload progress */
  return new Promise(function (ok, fail) {
    var x = new XMLHttpRequest();
    x.open("POST", "cgi-bin/api?a=" + a);
    x.setRequestHeader("X-ES5XP", "1");
    x.setRequestHeader("Content-Type", "application/octet-stream");
    x.upload.onprogress = function (e) { if (e.lengthComputable && onprog) onprog(e.loaded / e.total); };
    x.onload = function () {
      var t = x.responseText || "";
      if (x.status >= 200 && x.status < 300) ok(t); else fail(new Error(t.trim() || ("HTTP " + x.status)));
    };
    x.onerror = function () { fail(new Error("connection failed")); };
    x.send(file);
  });
}

/* --------------------------------------------------------------- model */
function parseCfg(t) {
  var m = {};
  t.split("\n").forEach(function (l) { var i = l.indexOf("="); if (i > 0) m[l.slice(0, i)] = l.slice(i + 1); });
  return m;
}
function cur(k) {
  if (k in S.edits) return S.edits[k] === null ? undefined : S.edits[k];
  return S.cfg[k];
}
function setk(k, v) {   /* v undefined/null -> delete the key */
  var o = S.cfg[k];
  if (v === undefined || v === null) { if (o === undefined) delete S.edits[k]; else S.edits[k] = null; return; }
  v = String(v);
  if (o === v) delete S.edits[k]; else S.edits[k] = v;
}
function setDef(k, v, def) {   /* default value stays absent if the key is absent */
  v = String(v);
  if (v === String(def) && S.cfg[k] === undefined) setk(k); else setk(k, v);
}
function enabled(k, def) { var v = cur(k); return v === undefined ? !!def : v === "enabled"; }
function allKeys() {
  var o = {}, k;
  for (k in S.cfg) o[k] = 1;
  for (k in S.edits) { if (S.edits[k] === null) delete o[k]; else o[k] = 1; }
  return Object.keys(o);
}
function nEdits() { return Object.keys(S.edits).length; }
function needsTest() { return Object.keys(S.edits).some(function (k) { return TEST_KEYS.test(k); }); }
function diffBody() {
  return Object.keys(S.edits).sort().map(function (k) {
    return S.edits[k] === null ? "-" + k : k + "=" + S.edits[k];
  }).join("\n") + "\n";
}

/* ---------------------------------------------------------- validation */
var RX = {
  name32: /^[A-Za-z0-9 ._-]{1,32}$/, name64: /^[A-Za-z0-9 ._-]{1,64}$/,
  host: /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
};
function isIP(v) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return false;
  for (var i = 1; i < 5; i++) if (+m[i] > 255 || (m[i].length > 1 && m[i][0] === "0")) return false;
  return true;
}
function ipNum(v) { return v.split(".").reduce(function (a, o) { return a * 256 + (+o); }, 0); }
function isMask(v) {
  if (!isIP(v)) return false;
  var n = ipNum(v), inv = 4294967295 - n;
  return n !== 0 && ((inv + 1) & inv) === 0;
}
function intIn(v, a, b, step) {
  if (!/^(0|[1-9]\d{0,9})$/.test(v)) return false;
  v = +v; return v >= a && v <= b && (!step || v % step === 0);
}
function check(kind, v, d) {
  if (kind === "ip") return isIP(v);
  if (kind === "mask") return isMask(v);
  if (kind === "int") return intIn(v, +d.min, +d.max, d.step ? +d.step : 0);
  if (RX[kind]) return RX[kind].test(v);
  return false;
}

/* ------------------------------------------------- control builders */
function da(o) {
  var s = "", k;
  for (k in o) if (o[k] !== undefined && o[k] !== null) s += " data-" + k + '="' + esc(o[k]) + '"';
  return s;
}
function cb(o, on, label, dis) {
  return '<label class="cb"><input type="checkbox"' + da(o) + (on ? " checked" : "") + (dis ? " disabled" : "") +
    ">" + (label ? " " + esc(label) : "") + "</label>";
}
function sel(o, opts, val, dis) {
  var h = "<select" + da(o) + (dis ? " disabled" : "") + ">";
  opts.forEach(function (x) {
    h += '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(val) ? " selected" : "") + ">" + esc(x[1]) + "</option>";
  });
  return h + "</select>";
}
function tx(o, val, cls, ph, dis) {
  return '<input type="text"' + da(o) + ' value="' + esc(val == null ? "" : val) + '"' +
    (cls ? ' class="' + cls + '"' : "") + (ph ? ' placeholder="' + esc(ph) + '"' : "") +
    (dis ? " disabled" : "") + ' spellcheck="false" autocomplete="off">';
}
function rangeOpts(a, b, step, def) {
  var o = [];
  for (var v = a; v <= b; v += step) o.push([String(v), String(v) + (v === def ? " (default)" : "")]);
  return o;
}
function row(k, v, cls) { return '<div class="k">' + k + '</div><div class="v' + (cls ? " " + cls : "") + '">' + v + "</div>"; }
function hint(key, label) { return '<span class="hasHint" data-hint="' + esc(key) + '">' + esc(label || key) + "</span>"; }

/* ------------------------------------------------------ composite keys */
var MODES = [["auto", "Auto"], ["1000F", "1 Gbps FDX"], ["100F", "100 Mbps FDX"], ["100H", "100 Mbps HDX"],
             ["10F", "10 Mbps FDX"], ["10H", "10 Mbps HDX"]];
function getMode(p) {
  if (cur(pk(p, "autoneg")) !== "disabled") return "auto";
  return (cur(pk(p, "speed")) || "100") + (cur(pk(p, "duplex")) === "disabled" ? "H" : "F");
}
function setMode(p, m) {   /* as the vendor writes: speed 100 and full duplex stay absent */
  if (m === "auto") { setk(pk(p, "autoneg")); setk(pk(p, "speed")); setk(pk(p, "duplex")); return; }
  var s = m.slice(0, -1), d = m.slice(-1);
  setk(pk(p, "autoneg"), "disabled");
  setk(pk(p, "speed"), s === "100" ? undefined : s);
  setk(pk(p, "duplex"), d === "H" ? "disabled" : undefined);
}
function getEdge(p) {
  if (cur(sk(p, "auto_edge")) === "enabled") return "auto";
  return cur(sk(p, "edge")) === "enabled" ? "enable" : "disable";
}
function setEdge(p, v) {
  setDef(sk(p, "edge"), v === "enable" ? "enabled" : "disabled", "disabled");
  setDef(sk(p, "auto_edge"), v === "auto" ? "enabled" : "disabled", "disabled");
}
var STORM = [["unicasts", "Unknown unicast"], ["multicasts", "Unregistered multicast"], ["broadcasts", "Broadcast"]];
function stormKeys(p) {
  var ks = [pk(p, "storm_control.status")];
  STORM.forEach(function (s) { ks.push(pk(p, "storm_control." + s[0] + ".status"), pk(p, "storm_control." + s[0] + ".limit")); });
  return ks;
}
function mirSources() { return PORTS.filter(function (p) { return !!cur(pk(p, "mirror.source")); }); }
function mirTarget() {
  if (S.mirT !== null) return S.mirT;
  var s = mirSources();
  return s.length ? (cur(pk(s[0], "mirror.target")) || "") : "";
}
function writeMirror(t, srcs) {
  PORTS.forEach(function (p) {
    if (t && srcs.indexOf(p) >= 0 && String(p) !== t) {
      setk(pk(p, "mirror.source"), "both"); setk(pk(p, "mirror.target"), t);
    } else { setk(pk(p, "mirror.source")); setk(pk(p, "mirror.target")); }
  });
}
function vlanIds() {
  var ids = [];
  allKeys().forEach(function (k) { var m = /^switch\.vlan\.(\d+)\.id$/.exec(k); if (m) ids.push(+m[1]); });
  return ids.sort(function (a, b) { return a - b; });
}
function vmode(v, p) { return cur(vk(v, "port." + p + ".mode")) || "excluded"; }
function vlanConflicts() {   /* port -> list of VLANs where it is untagged (only >1 kept) */
  var c = {};
  PORTS.forEach(function (p) {
    var l = vlanIds().filter(function (v) { return cur(vk(v, "status")) !== "disabled" && vmode(v, p) === "untagged"; });
    if (l.length > 1) c[p] = l;
  });
  return c;
}
function stpTimerErr() {   /* IEEE 802.1D-2004 17.14; checked while STP is on or a timer is edited */
  var K = "switch.rstp.bridge.";
  if (!enabled("switch.rstp.status") && !((K + "max_age") in S.edits || (K + "forward_delay") in S.edits || (K + "hello_time") in S.edits)) return "";
  var ma = +(cur(K + "max_age") || 20), fd = +(cur(K + "forward_delay") || 15), ht = +(cur(K + "hello_time") || 2);
  if (ma > 2 * (fd - 1)) return "STP: max age " + ma + " is more than 2 \u00d7 (forward delay \u2212 1) = " + 2 * (fd - 1);
  if (ma < 2 * (ht + 1)) return "STP: max age " + ma + " is less than 2 \u00d7 (hello time + 1) = " + 2 * (ht + 1);
  return "";
}
function netMode() { return cur("dhcpc.status") === "enabled" ? "dhcp" : "static"; }
function setNetMode(m) {
  if (m === "dhcp") {
    setk("dhcpc.status", "enabled"); setk("dhcpc.1.devname", "br0");
    if (!cur("dhcpc.1.fallback")) setk("dhcpc.1.fallback", cur("netconf.3.ip") || "192.168.1.20");
    if (!cur("dhcpc.1.fallback_netmask")) setk("dhcpc.1.fallback_netmask", cur("netconf.3.netmask") || "255.255.255.0");
    ["netconf.3.ip", "netconf.3.netmask", "route.1.devname", "route.1.gateway", "route.1.ip",
     "route.1.netmask", "route.1.status"].forEach(function (k) { setk(k); });
    delete S.bad["route.1.gateway"];
  } else {
    setk("dhcpc.status", "disabled");
    setk("netconf.3.ip", cur("netconf.3.ip") || cur("dhcpc.1.fallback") || "192.168.1.20");
    setk("netconf.3.netmask", cur("netconf.3.netmask") || cur("dhcpc.1.fallback_netmask") || "255.255.255.0");
    setk("route.1.devname", "br0"); setk("route.1.ip", "0.0.0.0"); setk("route.1.netmask", "0");
    setk("route.1.status", "enabled"); setk("route.status", "enabled");
    if (!cur("route.1.gateway")) S.bad["route.1.gateway"] = 1;
  }
}
function setDns(n, v) {
  var ip = "resolv.nameserver." + n + ".ip", st = "resolv.nameserver." + n + ".status";
  if (v) { setk(ip, v); setk(st, "enabled"); } else { setk(ip); setk(st); }
  if (cur("resolv.nameserver.1.ip") || cur("resolv.nameserver.2.ip")) setk("resolv.nameserver.status", "enabled");
}
var TZ = (function () {
  var o = [];
  for (var h = -12; h <= 14; h++) {
    var v = h === 0 ? "GMT" : "GMT" + (h > 0 ? "-" + h : "+" + (-h));   /* POSIX sign is inverted */
    o.push([v, "UTC" + (h === 0 ? "" : (h > 0 ? "+" : "\u2212") + Math.abs(h))]);
  }
  return o;
})();
function tzLabel(v) {   /* "GMT-3" -> "UTC+3 (GMT-3)"; unknown forms as they are */
  for (var j = 0; j < TZ.length; j++) if (TZ[j][0] === v) return TZ[j][1] + (v === "GMT" ? "" : " (" + v + ")");
  return v || "\u2014";
}
function sshSlots() {
  var r = [];
  for (var n = 1; n <= 8; n++) if (cur("sshd.auth.key." + n + ".value")) r.push(n);
  return r;
}

/* ---------------------------------------------------- field handlers */
var KINDS = {
  en: function (t, d) { setk(d.k, t.checked ? "enabled" : "disabled"); },
  endef: function (t, d) { setDef(d.k, t.checked ? "enabled" : "disabled", d.def); },
  endel: function (t, d) { setk(d.k, t.checked ? "enabled" : undefined); },
  sel: function (t, d) { setk(d.k, t.value); },
  seldef: function (t, d) { setDef(d.k, t.value, d.def); },
  val: function (t, d) {   /* text: d.v = validator, d.empty = "del" allows an empty field */
    var v = t.value.trim();
    if (v === "" && d.empty === "del") { setk(d.k); return true; }
    if (!check(d.v, v, d)) return false;
    if (d.def !== undefined) setDef(d.k, v, d.def); else setk(d.k, v);
    return true;
  },
  pmode: function (t, d) { setMode(d.p, t.value); },
  edge: function (t, d) { setEdge(d.p, t.value); },
  storm: function (t, d) {
    if (t.checked) setk(pk(d.p, "storm_control.status"), "enabled");
    else stormKeys(d.p).forEach(function (k) { setk(k); delete S.bad[k]; });
  },
  stormsub: function (t, d) {
    var st = pk(d.p, "storm_control." + d.s + ".status"), li = pk(d.p, "storm_control." + d.s + ".limit");
    if (t.checked) { setk(st, "enabled"); setk(li, cur(li) || "1000"); } else { setk(st); setk(li); delete S.bad[li]; }
  },
  mirtgt: function (t) {
    S.mirT = t.value;
    writeMirror(t.value, mirSources());
  },
  mirsrc: function (t, d) {
    var s = mirSources().filter(function (p) { return p !== +d.p; });
    if (t.checked) s.push(+d.p);
    writeMirror(mirTarget(), s);
  },
  netmode: function (t) { setNetMode(t.value); },
  dns: function (t, d) {
    var v = t.value.trim();
    if (v !== "" && !isIP(v)) return false;
    setDns(d.n, v); return true;
  },
  tz: function (t) { setk("system.timezone", t.value); setk("system.timezone.name", t.value); },
  vname: function (t, d) {
    var v = t.value.trim();
    if (!RX.name32.test(v)) return false;
    setk(vk(d.vid, "name"), v); return true;
  }
};
var TEXT_KINDS = { val: 1, dns: 1, vname: 1 };

function onField(e) {
  var t = e.target, d = t.dataset;
  if (!d || !d.kind || !KINDS[d.kind]) return;
  var isText = !!TEXT_KINDS[d.kind];
  if (isText !== (e.type === "input")) return;
  var r = KINDS[d.kind](t, d);
  var id = d.k || (d.kind + (d.p || "") + (d.s || "") + (d.n || "") + (d.vid || ""));
  if (isText) {
    if (r === false) S.bad[id] = 1; else delete S.bad[id];
    t.classList.toggle("invalid", r === false);
    refreshDirty();
  } else {
    render();
  }
}

function refreshDirty() {
  var nodes = document.querySelectorAll("#page [data-keys], #page [data-k]");
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], ks = (n.dataset.keys || n.dataset.k).split(" ");
    var ch = ks.some(function (k) { return k in S.edits; });
    var tgt = (n.parentNode && n.parentNode.classList && n.parentNode.classList.contains("cb")) ? n.parentNode : n;
    tgt.classList.toggle("changed", ch);
  }
  applyBar();
}

/* ------------------------------------------------------- apply bar */
function applyBar() {
  var n = nEdits(), nb = Object.keys(S.bad).length, conf = Object.keys(vlanConflicts()).length, stp = n ? stpTimerErr() : "";
  var bar = el("applybar");
  bar.hidden = n === 0 && nb === 0;
  if (bar.hidden) return;
  var t = n + (n === 1 ? " change" : " changes");
  if (needsTest()) t += " \u00b7 trial apply: confirmed automatically while this page can reach the switch, otherwise reverted after " + (TEST_SEC / 60) + " min";
  if (nb) t += " \u00b7 fix " + nb + " invalid field" + (nb > 1 ? "s" : "");
  if (conf) t += " \u00b7 a port is untagged in more than one VLAN";
  if (stp) t += " \u00b7 " + stp;
  el("abText").textContent = t;
  el("abApply").disabled = n === 0 || nb > 0 || conf > 0 || !!stp || !!S.follow;
  el("abApply").textContent = needsTest() ? "Apply (trial)" : "Apply";
  el("abDiff").hidden = !S.showDiff;
  if (S.showDiff) el("abDiff").textContent = diffBody();
}
function discard() { S.edits = {}; S.bad = {}; S.mirT = null; S.showDiff = false; render(); }

function apply() {
  var test = needsTest(), body = diffBody();
  var ip = S.edits["netconf.3.ip"], toDhcp = S.edits["dhcpc.status"] === "enabled";
  S.newUrl = (test && ip && ip !== location.hostname && netMode() === "static")
    ? "http://" + ip + (location.port ? ":" + location.port : "") + "/#system" : "";
  S.toDhcp = test && toDhcp;
  el("abApply").disabled = true;
  banner("warn", "Applying\u2026");
  api("set", { q: test ? "mode=test" : "", body: body }).then(function (t) {
    S.edits = {}; S.bad = {}; S.mirT = null; S.showDiff = false;
    S.deadline = test ? Date.now() + TEST_SEC * 1000 : 0;
    S.reach = 0;
    if (/no changes/.test(t)) { banner("ok", "No changes."); reload(); return; }
    if (S.newUrl) setTimeout(function () { location.href = S.newUrl; }, 6000);
    follow(test);
  }).catch(function (e) { banner("bad", "Not applied: " + e.message); applyBar(); });
}

function follow(test) {
  clearTimeout(S.follow);
  S.follow = setTimeout(function () {
    api("info", { json: true }).then(function (i) {
      S.info = i; S.reach = 0; hdrState();
      if (i.busy) {
        if (i.pending != null) revertBanner("Trial apply: applying configuration\u2026");
        else banner("warn", "Applying configuration\u2026");
        follow(test); return;
      }
      /* one idle answer is enough: the flash write (bgnd save-cfg) is registered before the apply clears its flag,
         so "busy" never drops between the two */
      S.follow = null;
      if (i.pending != null) { confirmNow(); return; }   /* reachable from this browser -> confirm */
      reload().then(function () { banner("ok", "Applied and saved."); });
    }).catch(function () {
      S.reach++; hdrState(true);
      if (test) banner("bad", unreachableText(), S.newUrl ? '<a href="' + esc(S.newUrl) + '">Open the new address</a>' : "");
      else banner("warn", "Waiting for the switch\u2026");
      follow(test);
    });
  }, S.reach ? 3000 : 1000);
}
function revertBanner(text) {   /* trial apply in progress: the saved configuration is one reboot away */
  banner("warn", text, '<button type="button" class="small danger" id="bnRevert">Revert now (reboot)</button>');
  el("bnRevert").onclick = function () {
    if (!confirm("Drop the trial configuration and reboot into the saved one?")) return;
    clearTimeout(S.follow); S.follow = null;
    api("revert", { body: "1" }).then(function () { waitReboot("Reverting: the switch reboots into the saved configuration\u2026"); })
      .catch(function (e) { banner("bad", "Revert failed: " + e.message); });
  };
}
function unreachableText() {
  var left = S.deadline ? Math.max(0, Math.round((S.deadline - Date.now()) / 1000)) : 0;
  var t = "No answer from the switch. ";
  if (S.newUrl) t += "The address changed: open the new address and log in there - the page confirms the change. ";
  else if (S.toDhcp) t += "DHCP was switched on: find the new address in your DHCP server leases and open it. ";
  t += "Without confirmation the switch reboots into the saved configuration" + (left ? " in about " + Math.ceil(left / 60) + " min." : ".");
  return t;
}
function confirmNow() {
  banner("warn", "The switch is reachable - confirming the trial apply\u2026");
  api("confirm", { body: "1" }).then(function () {
    return reload().then(function () { banner("ok", "Confirmed and written to flash."); });
  }).catch(function (e) { banner("bad", "Confirm failed: " + e.message); });
}

/* -------------------------------------------------- banner and header */
function banner(cls, text, extra) {
  var b = el("banner");
  if (!cls) { b.hidden = true; return; }
  b.className = "banner " + cls; b.hidden = false;
  b.innerHTML = '<span class="dot ' + (cls === "ok" ? "ok" : cls === "bad" ? "bad" : "warn live") + '"></span>' +
    '<span class="grow">' + esc(text) + "</span>" + (extra || "") +
    (cls === "ok" ? ' <button type="button" class="small" id="bnClose">OK</button>' : "");
  var c = el("bnClose"); if (c) c.onclick = function () { banner(); };
}
function hdrState(down) {
  var i = S.info, d = el("hdrDot"), s = el("hdrState");
  if (down || !i) { d.className = "dot bad"; s.textContent = "no connection"; return; }
  if (i.pending != null) { d.className = "dot warn live"; s.textContent = "trial apply \u00b7 " + i.pending + " s"; return; }
  if (i.busy) { d.className = "dot warn live"; s.textContent = "applying"; return; }
  d.className = "dot ok"; s.textContent = (i.user || "") + " \u00b7 " + (i.time || "");
}

/* ----------------------------------------------------------- loading */
function setSubtitle() {   /* "EdgeSwitch 5XP PoE - Firmware: SW.ar7240.v2.4.1.12..." */
  var i = S.info || {};
  el("subtitle").textContent = (i.name || "EdgeSwitch 5XP") + (i.version ? " \u2014 Firmware: " + i.version : "");
}
function reload() {
  return Promise.all([api("cfg"), api("info", { q: "full=1", json: true })]).then(function (r) {
    S.cfg = parseCfg(r[0]); S.info = r[1]; S.loaded = true;
    setSubtitle();
    hdrState(); render();
  });
}

/* ----------------------------------------------------------- format */
function fmtBytes(n) {
  if (n == null) return "\u2014";
  var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) : n) + " " + u[i];
}
function fmtUp(s) {
  s = Math.floor(s || 0);
  var d = Math.floor(s / 86400); s %= 86400;
  var h = Math.floor(s / 3600); s %= 3600;
  return (d ? d + "d " : "") + h + "h " + Math.floor(s / 60) + "m";
}
function n0(v) { return v == null ? "\u2014" : String(v); }

/* ============================================================ pages */
var PAGES = {};

/* ---------------------------------------------------------- status */
PAGES.status = function () {
  var i = S.info || {}, h = "";
  var st = i.pending != null ? ["warn", "trial apply"] : i.busy ? ["warn", "applying"] : ["ok", "OK"];
  h += '<div class="kpis">' +
    '<div class="tile ' + st[0] + '"><div class="ctl"><div class="ctl-row"><span class="dot ' + st[0] + '"></span>' +
    '<span class="name">System</span><span class="val ' + st[0] + '">' + st[1] + "</span></div>" +
    '<div class="ctl-row sub"><span class="name">Uptime</span><span class="val">' + fmtUp(i.uptime) + "</span></div></div></div>" +
    '<div class="tile"><div class="ctl"><div class="ctl-row"><span class="name">Updated</span><span class="val" id="stamp">' +
    esc(S.stamp || "\u2014") + "</span></div>" +
    '<div class="ctl-row sub"><span class="name">Load</span><span class="val">' + esc(i.load || "\u2014") + "</span></div></div></div>" +
    '<div class="tile"><div class="ctl"><div class="ctl-row"><button type="button" id="refresh">Refresh</button>' +
    '<label class="cb" style="margin-left:auto"><input type="checkbox" id="auto"' + (S.auto ? " checked" : "") + "> auto 5 s</label></div>" +
    '<div class="ctl-row sub"><span class="name">Configuration</span><span class="val">' + esc(i.cfgstate || "\u2014") + "</span></div></div></div></div>";

  h += '<div class="grid"><div class="card wide"><h2>Ports</h2><div class="scroll"><table><thead><tr>' +
    '<th>Port</th><th class="l">Name</th><th class="l">Link</th><th class="l">STP</th><th>Rx</th><th>Tx</th>' +
    "<th>Rx pkts</th><th>Tx pkts</th><th>Drops rx/tx</th><th>Errors rx/tx</th><th>Bcast rx/tx</th><th>Mcast rx/tx</th><th>PoE</th>" +
    "</tr></thead><tbody>";
  var pl = (S.ports && S.ports.ports) || [];
  var stpOn = enabled("switch.rstp.status");   /* with STP off the ASIC port state means nothing */
  if (!pl.length) h += '<tr><td colspan="13" class="empty">no data</td></tr>';
  pl.forEach(function (x) {
    var m = /^0\/(\d)$/.exec(x.portId || ""), p = m ? +m[1] : null, admin = x.portId === "1/1";
    var name = p ? (cur(pk(p, "name")) || "Port " + p) : admin ? "Management" : x.portId;
    var off = p && cur(pk(p, "status")) === "disabled";
    var link = off ? '<span class="muted">disabled</span>' :
      x.linkUp ? '<span class="ok-t">\u25cf ' + x.speed + " " + (x.duplex === "full" ? "FDX" : "HDX") + "</span>" :
      '<span class="muted">down</span>';
    var poe = p ? (cur(pk(p, "poe")) === "24" ? '<span class="warn-t">24 V</span>' : "off") : "";
    h += "<tr><td>" + (p || (admin ? "M" : esc(x.portId))) + '</td><td class="l">' + esc(name) + '</td><td class="l">' + link +
      '</td><td class="l">' + (stpOn && p ? esc(x.stpState || "") : '<span class="muted">\u2014</span>') + "</td><td>" + fmtBytes(x.rxBytes) + "</td><td>" + fmtBytes(x.txBytes) +
      "</td><td>" + n0(x.rxPackets) + "</td><td>" + n0(x.txPackets) + "</td><td>" + n0(x.rxDropped) + " / " + n0(x.txDropped) +
      "</td><td>" + n0(x.rxErrors) + " / " + n0(x.txErrors) + "</td><td>" + n0(x.rxBroadcast) + " / " + n0(x.txBroadcast) +
      "</td><td>" + n0(x.rxMulticast) + " / " + n0(x.txMulticast) + "</td><td>" + poe + "</td></tr>";
  });
  h += "</tbody></table></div></div>";

  var stp = enabled("switch.rstp.status") ? (cur("switch.rstp.version") || "rstp").toUpperCase() : "off";
  h += '<div class="card wide"><h2>System</h2><div class="cols2"><div class="rows">' +
    row("Name", esc(i.name || "\u2014")) + row("IP address", esc(i.ip || "\u2014")) +
    row("Address mode", netMode() === "dhcp" ? "DHCP" : "static") + row("MAC", esc(i.mac || "\u2014")) +
    row("Free RAM", i.mem_avail_kb != null ? Math.round(i.mem_avail_kb / 1024) + " / " + Math.round(i.mem_total_kb / 1024) + " MB" : "\u2014") +
    '</div><div class="rows">' +
    row("Time", esc(i.time || "\u2014")) + row("Time zone", esc(tzLabel(i.tz))) +
    row("Jumbo frames", enabled("switch.jumboframes") ? "on (MTU 9216)" : "off") +
    row("QoS", cur("qos.status") === "enabled" ? '<span class="ok-t">on</span>' : "off") +
    row("Spanning tree", stp) +
    "</div></div></div>";

  h += "</div>";
  return h;
};
PAGES.status.after = function () {
  el("refresh").onclick = loadStatus;
  el("auto").onchange = function () {
    if (this.checked) S.auto = setInterval(loadStatus, 5000); else { clearInterval(S.auto); S.auto = null; }
  };
  if (!S.ports) loadStatus();
};
function loadStatus() {
  return Promise.all([api("info", { q: "full=1", json: true }), api("ports", { json: true })])
    .then(function (r) {
      S.info = r[0]; S.ports = r[1]; S.stamp = new Date().toLocaleTimeString();
      hdrState(); setSubtitle(); if (S.page === "status") render();
    }).catch(function () { hdrState(true); });
}

/* ----------------------------------------------------------- ports */
PAGES.ports = function () {
  var h = '<div class="grid">';
  h += '<div class="card wide"><h2>Ports</h2><div class="scroll"><table class="form"><thead><tr>' +
    '<th>Port</th><th class="l">Name</th><th class="c">Enabled</th><th class="l">Mode</th><th class="c">' + hint("Flow control") +
    '</th><th class="l">PoE</th><th class="c">' + hint("Isolate") + '</th><th class="c">' + hint("Link") + "</th></tr></thead><tbody>";
  PORTS.forEach(function (p) {
    var m = getMode(p);
    h += "<tr><td>" + p + '</td><td class="l">' + tx({ kind: "val", k: pk(p, "name"), v: "name32" }, cur(pk(p, "name")) || "Port " + p, "w14") +
      '</td><td class="c">' + cb({ kind: "endef", k: pk(p, "status"), def: "enabled" }, enabled(pk(p, "status"), true)) +
      '</td><td class="l">' + sel({ kind: "pmode", p: p, keys: [pk(p, "autoneg"), pk(p, "speed"), pk(p, "duplex")].join(" ") }, MODES, m) +
      '</td><td class="c">' + cb({ kind: "en", k: pk(p, "flowctrl.status") }, enabled(pk(p, "flowctrl.status"))) +
      (m !== "auto" && enabled(pk(p, "flowctrl.status")) ? ' <span class="note warn" style="margin:0">Auto only</span>' : "") +
      '</td><td class="l">' + sel({ kind: "sel", k: pk(p, "poe") }, [["0", "Off"], ["24", "24 V"]], cur(pk(p, "poe")) || "0") +
      '</td><td class="c">' + cb({ kind: "endel", k: pk(p, "isolation") }, enabled(pk(p, "isolation"))) +
      '</td><td class="c"><button type="button" class="small" data-lreset="' + p + '"' + (S.cfg[pk(p, "status")] === "disabled" ? " disabled" : "") + ">Reset</button></td></tr>";
  });
  h += '</tbody></table></div><div class="note">PoE 24 V is passive: switch it on only for a device that expects passive 24 V.</div></div>';

  /* storm control */
  h += '<div class="card wide"><h2>' + hint("Storm control") + "</h2>" +
    '<div class="scroll"><table class="form"><thead><tr><th>Port</th><th class="c">On</th>';
  STORM.forEach(function (s) { h += '<th class="l">' + s[1] + "</th>"; });
  h += "</tr></thead><tbody>";
  PORTS.forEach(function (p) {
    var on = enabled(pk(p, "storm_control.status"));
    h += "<tr><td>" + p + '</td><td class="c">' + cb({ kind: "storm", p: p, keys: stormKeys(p).join(" ") }, on) + "</td>";
    STORM.forEach(function (s) {
      var st = pk(p, "storm_control." + s[0] + ".status"), li = pk(p, "storm_control." + s[0] + ".limit");
      var sub = on && enabled(st);
      h += '<td class="l"><span class="inline">' + cb({ kind: "stormsub", p: p, s: s[0], keys: st }, sub, "", !on) +
        (sub ? tx({ kind: "val", k: li, v: "int", min: 1, max: 1000000 }, cur(li) || "", "w8 mono") + ' <span class="muted">Kbps</span>' : "") +
        "</span></td>";
    });
    h += "</tr>";
  });
  h += '</tbody></table></div><div class="note">PTP event and general messages are multicast: an "Unregistered multicast" limit can drop them.</div></div>';

  /* mirroring */
  var t = mirTarget(), srcs = mirSources();
  h += '<div class="card"><h2>' + hint("Mirroring") + '</h2><div class="fields"><label class="field"><span>Target port</span>' +
    sel({ kind: "mirtgt", keys: PORTS.map(function (p) { return pk(p, "mirror.target"); }).join(" ") },
      [["", "none"]].concat(PORTS.map(function (p) { return [String(p), "Port " + p]; })), t) + "</label>" +
    '<div class="field"><span>Source ports (Rx + Tx)</span><span class="inline">';
  PORTS.forEach(function (p) {
    h += cb({ kind: "mirsrc", p: p, keys: pk(p, "mirror.source") }, srcs.indexOf(p) >= 0, String(p), !t || String(p) === t);
  });
  h += "</span></div></div>" + (t ? '<div class="note warn">Incoming traffic on port ' + esc(t) + " is blocked while it is the mirror target.</div>" : "") + "</div>";

  /* spanning tree per port */
  var bon = enabled("switch.rstp.status");
  h += '<div class="card wide"><h2>Spanning tree \u2014 ports</h2><div class="scroll"><table class="form"><thead><tr><th>Port</th><th class="c">STP</th><th class="l">' + hint("Edge port") +
    '</th><th class="l">Port priority</th><th class="l">' + hint("Path cost") + "</th></tr></thead><tbody>";
  PORTS.forEach(function (p) {
    h += "<tr><td>" + p + '</td><td class="c">' + cb({ kind: "en", k: sk(p, "status") }, enabled(sk(p, "status"))) +
      '</td><td class="l">' + sel({ kind: "edge", p: p, keys: sk(p, "edge") + " " + sk(p, "auto_edge") },
        [["disable", "Disable"], ["enable", "Enable"], ["auto", "Auto"]], getEdge(p)) +
      '</td><td class="l">' + sel({ kind: "seldef", k: sk(p, "priority"), def: "128" }, rangeOpts(0, 240, 16, 128), cur(sk(p, "priority")) || "128") +
      '</td><td class="l">' + tx({ kind: "val", k: sk(p, "path_cost"), v: "int", min: 0, max: 200000000, def: "0" }, cur(sk(p, "path_cost")) || "0", "w10 mono") +
      "</td></tr>";
  });
  h += '</tbody></table></div><div class="note">' + (bon ? "" : "Spanning tree is off for the switch (System page): per-port settings take effect when it is on. ") +
    "Ports with STP off filter BPDUs: the switch does not take part in spanning tree on them.</div></div>";
  return h + "</div>";
};

PAGES.ports.after = function () {
  Array.prototype.forEach.call(document.querySelectorAll("#page [data-lreset]"), function (b) {
    b.onclick = function () {   /* vendor "Reset Port Link" (and PoE power when PoE is on) */
      var p = b.dataset.lreset, poe = (S.cfg[pk(p, "poe")] || "0") !== "0";
      if (!confirm("Reset the link of port " + p + (poe ? " and its PoE power" : "") + "?\nThe port is without link for about 8 seconds.")) return;
      b.disabled = true;
      banner("warn", "Resetting the link of port " + p + "\u2026");
      api("linkreset", { q: "p=" + p, body: "1" }).then(function (t) { banner("ok", t.trim()); })
        .catch(function (e) { banner("bad", e.message); }).then(function () { b.disabled = false; });
    };
  });
};

/* ------------------------------------------------------------ VLAN */
PAGES.vlan = function () {
  var ids = vlanIds(), conf = vlanConflicts();
  var h = '<div class="grid"><div class="card wide"><h2>VLANs</h2>' +
    '<div class="scroll"><table class="form"><thead><tr><th>ID</th><th class="l">Name</th>';
  PORTS.forEach(function (p) { h += '<th class="c">' + p + "</th>"; });
  h += '<th class="c">All ports</th><th class="c"></th></tr></thead><tbody>';
  ids.forEach(function (v) {
    h += "<tr><td>" + v + '</td><td class="l">' + tx({ kind: "vname", vid: v, keys: vk(v, "name") }, cur(vk(v, "name")) || "", "w14") + "</td>";
    PORTS.forEach(function (p) {
      var m = vmode(v, p), L = m === "untagged" ? "U" : m === "tagged" ? "T" : "E";
      var bad = conf[p] && m === "untagged";
      h += '<td class="c"><button type="button" class="vm ' + L + (bad ? " conflict" : "") + '" data-vlan="' + v + '" data-port="' + p +
        '" data-keys="' + vk(v, "port." + p + ".mode") + '" title="' + m + '">' + L + "</button></td>";
    });
    h += '<td class="c"><span class="inline">' + [["untagged", "U"], ["tagged", "T"], ["excluded", "E"]].map(function (x) {
      return '<button type="button" class="vm ' + x[1] + '" data-vall="' + v + '" data-m="' + x[0] + '" title="all ports: ' + x[0] + '">' + x[1] + "</button>";
    }).join("") + "</span></td>";
    h += '<td class="c">' + (v === 1 ? "" : '<button type="button" class="small" data-vdel="' + v + '">Delete</button>') + "</td></tr>";
  });
  h += '</tbody></table></div><div class="btns">' + tx({}, "", "w6 mono", "ID", false).replace("<input", '<input id="newVid"') +
    '<button type="button" id="addVlan">Add VLAN</button><span class="muted">2\u20134094; created with all ports E</span></div>' +
    '<div class="note">Click a port to cycle U \u2192 T \u2192 E: <b>U</b> untagged (the port\u2019s PVID), <b>T</b> tagged, <b>E</b> excluded. A port can be untagged in one VLAN only. ' +
    "A trunk port is a port marked T in every VLAN it carries. The CPU (management) stays in VLAN 1 only.</div>" +
    (Object.keys(conf).length ? '<div class="note warn">Untagged in more than one VLAN: ' + Object.keys(conf).map(function (p) {
      return "port " + p + " (" + conf[p].join(", ") + ")"; }).join("; ") + "</div>" : "") + "</div>";
  h += '<div class="card"><h2>' + hint("Management VLAN") + '</h2><div class="rows">' +
    row("Management VLAN", esc(cur("switch.managementvlan") || "1")) + "</div>" +
    '<div class="note">Shown only: changing it also moves the admin port and the CPU port.</div></div></div>';
  return h;
};
PAGES.vlan.after = function () {
  var bs = document.querySelectorAll("#page .vm[data-port]");
  Array.prototype.forEach.call(bs, function (b) {
    b.onclick = function () {
      var v = +b.dataset.vlan, p = +b.dataset.port, m = vmode(v, p);
      var next = m === "untagged" ? "tagged" : m === "tagged" ? "excluded" : "untagged";
      setk(vk(v, "port." + p + ".mode"), next);
      render();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll("#page [data-vall]"), function (b) {
    b.onclick = function () {   /* vendor "Apply to All Ports" */
      var v = b.dataset.vall, m = b.dataset.m;
      PORTS.forEach(function (p) { setk(vk(v, "port." + p + ".mode"), m); });
      render();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll("#page [data-vdel]"), function (b) {
    b.onclick = function () {
      var v = b.dataset.vdel;
      allKeys().forEach(function (k) { if (k.indexOf("switch.vlan." + v + ".") === 0) setk(k); });
      render();
    };
  });
  el("addVlan").onclick = function () {
    var v = el("newVid").value.trim();
    if (!intIn(v, 2, 4094) || vlanIds().indexOf(+v) >= 0) { el("newVid").classList.add("invalid"); return; }
    setk(vk(v, "id"), v); setk(vk(v, "name"), "VLAN " + v); setk(vk(v, "status"), "enabled");
    PORTS.forEach(function (p) { setk(vk(v, "port." + p + ".mode"), "excluded"); });
    render();
  };
};

/* ------------------------------------------------------------- QoS */
PAGES.qos = function () {
  var on = enabled("qos.status"), dm = cur("qos.dscp") || "standard";
  var h = '<div class="grid"><div class="card"><h2>QoS</h2><div class="rows">' +
    '<div class="k">Priorities by keys</div><div class="v">' + cb({ kind: "en", k: "qos.status" }, on) + "</div>" +
    '<div class="k">' + hint("DSCP map") + '</div><div class="v">' +
    sel({ kind: "seldef", k: "qos.dscp", def: "standard" }, [["standard", "standard (DSCP \u00bb 3)"], ["ptp", "PTP only"]], dm) + "</div>" +
    '<div class="k">PTP DSCP</div><div class="v">' +
    tx({ kind: "val", k: "qos.dscp.ptp", v: "int", min: 0, max: 63, def: "46" }, cur("qos.dscp.ptp") || "46", "w6 mono", "", dm !== "ptp") + "</div>" +
    '</div><div class="note">Off: the switch runs with the chip defaults that es5xp-qos restores.</div></div>';
  h += '<div class="card"><h2>ASIC</h2><div class="note">Compare the chip registers with the keys (read only, a few seconds).</div>' +
    '<div class="btns"><button type="button" id="qcheck">Check ASIC</button></div><pre class="out" id="qout"' +
    (S.out.q ? "" : " hidden") + ">" + esc(S.out.q || "") + "</pre></div>";
  h += '<div class="card wide"><h2>Ports</h2><div class="scroll"><table class="form"><thead><tr><th>Port</th><th class="l">' + hint("Trust") +
    '</th><th class="l">Priority</th><th class="c">' + hint("PTP") + '</th><th class="c">' + hint("Flood") + "</th></tr></thead><tbody>";
  PORTS.forEach(function (p) {
    h += "<tr><td>" + p + '</td><td class="l">' +
      sel({ kind: "seldef", k: qk(p, "trust"), def: "dot1p" }, [["dot1p", "802.1p (PCP)"], ["ip-dscp", "IP DSCP"], ["untrusted", "untrusted"]], cur(qk(p, "trust")) || "dot1p") +
      '</td><td class="l">' + sel({ kind: "seldef", k: qk(p, "prio"), def: "0" }, rangeOpts(0, 7, 1, 0), cur(qk(p, "prio")) || "0") +
      '</td><td class="c">' + cb({ kind: "endef", k: qk(p, "ptp"), def: "disabled" }, enabled(qk(p, "ptp"))) +
      '</td><td class="c">' + cb({ kind: "endef", k: qk(p, "flood"), def: "enabled" }, enabled(qk(p, "flood"), true)) + "</td></tr>";
  });
  h += "</tbody></table></div></div></div>";
  return h;
};
PAGES.qos.after = function () {
  el("qcheck").onclick = function () {
    var b = this; b.disabled = true; el("qout").hidden = false; el("qout").textContent = "checking\u2026";
    api("qoscheck").then(function (t) { S.out.q = t; el("qout").textContent = t; })
      .catch(function (e) { el("qout").textContent = e.message; }).then(function () { b.disabled = false; });
  };
};

/* ---------------------------------------------------------- system */
PAGES.system = function () {
  var nm = netMode(), h = '<div class="grid">';
  /* identity: name and network attributes */
  h += '<div class="card"><h2>Identity</h2><div class="fields"><label class="field"><span>Name</span>' +
    tx({ kind: "val", k: "resolv.host.1.name", v: "name64" }, cur("resolv.host.1.name") || "") + "</label>" +
    '<label class="field"><span>Address mode</span>' + sel({ kind: "netmode", keys: "dhcpc.status" }, [["static", "Static"], ["dhcp", "DHCP"]], nm) + "</label>";
  if (nm === "static") {
    h += '<label class="field"><span>IP address</span>' + tx({ kind: "val", k: "netconf.3.ip", v: "ip" }, cur("netconf.3.ip"), "mono") + "</label>" +
      '<label class="field"><span>Netmask</span>' + tx({ kind: "val", k: "netconf.3.netmask", v: "mask" }, cur("netconf.3.netmask"), "mono") + "</label>" +
      '<label class="field"><span>Gateway</span>' + tx({ kind: "val", k: "route.1.gateway", v: "ip" }, cur("route.1.gateway"), "mono" + (S.bad["route.1.gateway"] ? " invalid" : "")) + "</label>";
  } else {
    h += '<label class="field"><span>Fallback IP</span>' + tx({ kind: "val", k: "dhcpc.1.fallback", v: "ip" }, cur("dhcpc.1.fallback"), "mono") + "</label>" +
      '<label class="field"><span>Fallback netmask</span>' + tx({ kind: "val", k: "dhcpc.1.fallback_netmask", v: "mask" }, cur("dhcpc.1.fallback_netmask"), "mono") + "</label>";
  }
  h += '<label class="field rowstart"><span>DNS 1</span>' + tx({ kind: "dns", n: 1, keys: "resolv.nameserver.1.ip" }, cur("resolv.nameserver.1.ip"), "mono") + "</label>" +
    '<label class="field"><span>DNS 2</span>' + tx({ kind: "dns", n: 2, keys: "resolv.nameserver.2.ip" }, cur("resolv.nameserver.2.ip"), "mono") + "</label></div>" +
    '<div class="note">Address changes are applied as a trial: this page confirms them as soon as it reaches the switch again ' +
    "(on a new address after you log in there); without confirmation the switch reboots into the saved configuration after 5 min.</div></div>";
  var time = '<div class="sect"><h3>Time</h3><div class="fields">' +
    '<label class="field"><span>NTP client</span>' + cb({ kind: "en", k: "ntpclient.status" }, enabled("ntpclient.status")) + "</label>" +
    '<label class="field"><span>NTP server 1</span>' + tx({ kind: "val", k: "ntpclient.1.server", v: "host", empty: "del" }, cur("ntpclient.1.server"), "mono") + "</label>" +
    '<label class="field"><span>NTP server 2</span>' + tx({ kind: "val", k: "ntpclient.2.server", v: "host", empty: "del" }, cur("ntpclient.2.server"), "mono") + "</label>" +
    '<label class="field"><span>Time zone</span>' + sel({ kind: "tz", keys: "system.timezone system.timezone.name" }, TZ, cur("system.timezone") || "GMT") + "</label>" +
    "</div></div>";

  var bon = enabled("switch.rstp.status"), ver = cur("switch.rstp.version") || "rstp";
  h += '<div class="card"><h2>Switch settings</h2><div class="fields">' +
    '<label class="field"><span>' + hint("Jumbo frames", "Jumbo frames (MTU 9216)") + "</span>" + cb({ kind: "en", k: "switch.jumboframes" }, enabled("switch.jumboframes")) + "</label>" +
    '<label class="field"><span>Spanning tree</span>' + cb({ kind: "endel", k: "switch.rstp.status" }, bon) + "</label>" +
    '<label class="field"><span>Version</span>' + sel({ kind: "seldef", k: "switch.rstp.version", def: "rstp" },
      [["rstp", "RSTP (802.1w)"], ["mstp", "MSTP (802.1s)"], ["stp", "STP (802.1D)"]], ver) + "</label>" +
    '<label class="field"><span>Max age, s</span>' + tx({ kind: "val", k: "switch.rstp.bridge.max_age", v: "int", min: 6, max: 40, def: "20" }, cur("switch.rstp.bridge.max_age") || "20", "mono") + "</label>" +
    '<label class="field"><span>Forward delay, s</span>' + tx({ kind: "val", k: "switch.rstp.bridge.forward_delay", v: "int", min: 4, max: 30, def: "15" }, cur("switch.rstp.bridge.forward_delay") || "15", "mono") + "</label>" +
    '<label class="field"><span>Hello time, s</span>' + tx({ kind: "val", k: "switch.rstp.bridge.hello_time", v: "int", min: 1, max: 10, def: "2" }, cur("switch.rstp.bridge.hello_time") || "2", "mono") + "</label>" +
    '<label class="field"><span>Priority</span>' + sel({ kind: "seldef", k: "switch.rstp.bridge.priority", def: "32768" },
      rangeOpts(0, 61440, 4096, 32768), cur("switch.rstp.bridge.priority") || "32768") + "</label>";
  var se = stpTimerErr();
  h += '</div>' + (se ? '<div class="note warn">' + esc(se) + "</div>" : "") +
    '<div class="note">Spanning tree timers must satisfy 2 \u00d7 (hello + 1) \u2264 max age \u2264 2 \u00d7 (forward delay \u2212 1). Per-port settings are on the Ports page.</div></div>';

  /* system settings: time, SSH, remote syslog */
  h += '<div class="card wide"><h2>System settings</h2><div class="sects">' + time + '<div class="sect"><h3>SSH</h3><div class="fields">' +
    '<label class="field"><span>SSH server</span>' + cb({ kind: "en", k: "sshd.status" }, enabled("sshd.status")) + "</label>" +
    '<label class="field"><span>Port</span>' + tx({ kind: "val", k: "sshd.port", v: "int", min: 1, max: 65535 }, cur("sshd.port") || "22", "mono") + "</label></div>" +
    '<div class="rows"><div class="sub">' + hint("SSH keys", "Authorized keys") + "</div>";
  var slots = sshSlots();
  if (!slots.length) h += '<div class="k muted">none</div><div class="v"></div>';
  slots.forEach(function (n) {
    var val = cur("sshd.auth.key." + n + ".value") || "";
    h += '<div class="k" data-keys="sshd.auth.key.' + n + '.value">' + esc(cur("sshd.auth.key." + n + ".type") || "") + " " +
      esc(cur("sshd.auth.key." + n + ".comment") || "") + '</div><div class="v"><span class="muted">\u2026' + esc(val.slice(-16)) +
      '</span> <button type="button" class="small" data-sshdel="' + n + '">Remove</button></div>';
  });
  h += '</div><div class="field" style="margin-top:8px"><span>Add a public key (one line, as in ~/.ssh/id_ed25519.pub)</span>' +
    '<textarea id="sshNew" rows="3" spellcheck="false"></textarea></div><div class="btns"><button type="button" id="sshAdd">Add key</button>' +
    '<span class="muted" id="sshMsg"></span></div></div>';

  h += '<div class="sect"><h3>Remote syslog</h3><div class="fields">' +
    '<label class="field"><span>Send to remote</span>' + cb({ kind: "en", k: "syslog.remote.status" }, enabled("syslog.remote.status")) + "</label>" +
    '<label class="field"><span>Server IP</span>' + tx({ kind: "val", k: "syslog.remote.ip", v: "ip", empty: "del" }, cur("syslog.remote.ip"), "mono") + "</label>" +
    '<label class="field"><span>Port</span>' + tx({ kind: "val", k: "syslog.remote.port", v: "int", min: 1, max: 65535 }, cur("syslog.remote.port") || "514", "mono") + "</label>" +
    "</div></div></div></div>";
  return h + "</div>";
};
PAGES.system.after = function () {
  el("sshAdd").onclick = function () {
    var m = /^\s*(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521))\s+([A-Za-z0-9+\/]+=*)(?:\s+(.*?))?\s*$/.exec(el("sshNew").value);
    if (!m) { el("sshMsg").textContent = "not an OpenSSH public key line"; return; }
    var n = 0;
    for (var i = 1; i <= 8; i++) if (!cur("sshd.auth.key." + i + ".value") && !cur("sshd.auth.key." + i + ".type")) { n = i; break; }
    if (!n) { el("sshMsg").textContent = "all 8 slots are used"; return; }
    var c = (m[3] || "").replace(/[^A-Za-z0-9 ._@:+-]/g, "_").slice(0, 64);
    setk("sshd.auth.key." + n + ".status", "enabled"); setk("sshd.auth.key." + n + ".type", m[1]);
    setk("sshd.auth.key." + n + ".value", m[2]); setk("sshd.auth.key." + n + ".comment", c || undefined);
    render();
  };
  Array.prototype.forEach.call(document.querySelectorAll("#page [data-sshdel]"), function (b) {
    b.onclick = function () {
      var n = b.dataset.sshdel;
      ["status", "type", "value", "comment"].forEach(function (x) { setk("sshd.auth.key." + n + "." + x); });
      render();
    };
  });
};

/* ----------------------------------------------------------- tools */
function portName(id) {   /* devinfo "0/3" -> "Port 3", "1/1" -> "Management" */
  var m = /^0\/(\d)$/.exec(id || "");
  return m ? (cur(pk(m[1], "name")) || "Port " + m[1]) : id === "1/1" ? "Management" : (id || "");
}
PAGES.tools = function () {
  var t = S.tool, h = '<div class="grid">';
  h += '<div class="card wide"><h2>Diagnostics</h2><div class="fields">' +
    '<label class="field"><span>Tool</span>' + sel({ id: "toolT" }, [["ping", "Ping"], ["traceroute", "Traceroute"], ["arping", "Arping"]], t.t).replace("<select", '<select id="toolT"') + "</label>" +
    '<label class="field"><span>' + (t.t === "arping" ? "IPv4 address" : "Host (IPv4 address or name)") + '</span><input type="text" id="toolH" class="mono" value="' + esc(t.h) + '" spellcheck="false" autocomplete="off"></label>' +
    (t.t === "traceroute" ? "" : '<label class="field"><span>Count</span>' + sel({}, rangeOpts(1, 10, 1, 4), t.c).replace("<select", '<select id="toolC"') + "</label>") +
    '</div><div class="btns"><button type="button" class="primary" id="toolRun">Run</button><span class="muted" id="toolMsg"></span></div>' +
    '<pre class="out" id="toolOut"' + (t.out ? "" : " hidden") + ">" + esc(t.out || "") + "</pre>" +
    '<div class="note">Arping sends ARP requests from br0: a reply means the address is in use on the network.</div></div>';

  var arp = (S.arp && S.arp.arp) || [], fdb = (S.fdb && S.fdb.fdb) || [];
  var ipOf = {}, portOf = {};
  arp.forEach(function (x) { ipOf[x.mac.toLowerCase()] = x.ip; });
  fdb.forEach(function (x) { var m = x.mac.toLowerCase(); if (!portOf[m]) portOf[m] = portName(x.port); });
  h += '<div class="card wide"><h2>MAC table</h2><div class="btns" style="margin:0 0 10px"><button type="button" id="tRefresh">Refresh</button>' +
    '<span class="muted">' + esc(S.toolsStamp || "") + "</span></div>" +
    '<div class="scroll"><table><thead><tr><th class="l">MAC</th><th class="l">IP</th><th class="l">Port</th><th>VLAN</th></tr></thead><tbody>';
  if (!fdb.length) h += '<tr><td colspan="4" class="empty">no data</td></tr>';
  fdb.forEach(function (x) {
    h += "<tr><td>" + esc(x.mac) + '</td><td class="l">' + esc(ipOf[x.mac.toLowerCase()] || "") + '</td><td class="l">' + esc(portName(x.port)) +
      "</td><td>" + esc(x.vlan) + "</td></tr>";
  });
  h += "</tbody></table></div></div>";

  h += '<div class="card wide"><h2>ARP table</h2><div class="scroll"><table><thead><tr><th class="l">IP</th><th class="l">MAC</th>' +
    '<th class="l">Port</th><th class="l">Interface</th></tr></thead><tbody>';
  if (!arp.length) h += '<tr><td colspan="4" class="empty">no data</td></tr>';
  arp.forEach(function (x) {
    h += "<tr><td>" + esc(x.ip) + '</td><td class="l">' + esc(x.mac) + '</td><td class="l">' + esc(portOf[x.mac.toLowerCase()] || "") +
      '</td><td class="l">' + esc(x.dev) + "</td></tr>";
  });
  h += "</tbody></table></div></div></div>";
  return h;
};
PAGES.tools.after = function () {
  var t = S.tool;
  el("toolT").onchange = function () { t.t = this.value; t.h = el("toolH").value; render(); };
  el("toolH").oninput = function () { t.h = this.value; };
  if (el("toolC")) el("toolC").onchange = function () { t.c = this.value; };
  el("toolRun").onclick = function () {
    var b = this, host = el("toolH").value.trim();
    if (!host) { el("toolMsg").textContent = "enter a host"; return; }
    t.h = host; b.disabled = true; el("toolMsg").textContent = "running\u2026";
    el("toolOut").hidden = false; el("toolOut").textContent = "";
    api("tool", { q: "t=" + t.t + "&h=" + encodeURIComponent(host) + "&c=" + (t.t === "traceroute" ? "1" : t.c), body: "1" })
      .then(function (r) { t.out = r; el("toolOut").textContent = r; el("toolMsg").textContent = ""; })
      .catch(function (e) { t.out = e.message; el("toolOut").textContent = e.message; el("toolMsg").textContent = ""; })
      .then(function () { b.disabled = false; });
  };
  el("tRefresh").onclick = loadTools;
  if (!S.fdb) loadTools();
};
function loadTools() {
  return Promise.all([api("fdb", { json: true }), api("arp", { json: true })]).then(function (r) {
    S.fdb = r[0]; S.arp = r[1]; S.toolsStamp = "updated " + new Date().toLocaleTimeString();
    if (S.page === "tools") render();
  }).catch(function (e) { banner("bad", "Tools: " + e.message); });
}

/* ----------------------------------------------------- maintenance */
PAGES.maint = function () {
  /* Firmware|Configuration and Password|Device are pairs: each card is a 4-row subgrid of the page grid
     (title / top / middle / bottom), so file pickers, buttons and notes of a pair sit on the same lines. */
  var i = S.info || {}, h = '<div class="grid">';
  h += '<div class="card sg"><h2>Firmware</h2><div class="sec"><div class="rows">' + row("Running", esc(i.version || "\u2014")) + "</div></div>" +
    '<div class="sec end"><div class="field"><span>Image (.bin): it is uploaded to /tmp and checked, nothing is written yet</span>' +
    '<input type="file" id="fwFile" accept=".bin"></div></div><div class="sec"><div class="btns"><button type="button" id="fwUp">Upload and check</button></div>' +
    '<progress id="fwProg" value="0" max="1" hidden></progress><pre class="out" id="fwOut" hidden></pre>' +
    '<div class="btns" id="fwGoBox"' + (i.fwfile ? "" : " hidden") + '><button type="button" class="primary" id="fwGo">Install and reboot</button>' +
    '<button type="button" id="fwCancel">Discard image</button><span class="muted">' + (i.fwfile ? "checked image in /tmp: " + i.fwfile + " bytes" : "") + "</span></div></div></div>";

  h += '<div class="card sg"><h2>Configuration</h2><div class="sec"><div class="btns first"><button type="button" id="bkGo">Download backup</button></div>' +
    '<div class="note">The backup contains the password hash: keep the file private.</div></div>' +
    '<div class="sec end"><div class="field"><span>Restore from a backup file: written to flash, then the switch reboots</span>' +
    '<input type="file" id="rsFile"></div></div><div class="sec"><div class="btns"><button type="button" id="rsGo">Restore</button></div><pre class="out" id="rsOut" hidden></pre></div></div>';

  h += '<div class="card sg"><h2>Password</h2><div class="sec"><div class="fields">' +
    '<label class="field"><span>New password</span><input type="password" id="pw1" autocomplete="new-password"></label>' +
    '<label class="field"><span>Repeat</span><input type="password" id="pw2" autocomplete="new-password"></label></div></div>' +
    '<div class="sec"><div class="btns"><button type="button" id="pwGo">Change password</button><span class="muted" id="pwMsg"></span></div></div>' +
    '<div class="sec"><div class="note">For user ' + esc(i.user || "") + '. The browser asks for the new password on the next request.</div></div></div>';

  h += '<div class="card sg"><h2>Device</h2><div class="sec end"><div class="btns inputs">' +
    '<button type="button" id="locate">' + (i.locate ? "Stop locate LED" : "Locate (blink LED)") + "</button>" +
    '<button type="button" id="rebootBtn">Reboot</button><button type="button" class="danger" id="resetBtn">Factory reset</button></div></div>' +
    '<div class="sec"></div><div class="sec"><div class="note">Factory reset: DHCP with fallback 192.168.1.20, user ubnt / ubnt, SSH on.</div></div></div>';

  h += '<div class="card wide"><h2>Log</h2><div class="btns"><button type="button" id="logBtn">Show log</button>' +
    '<span class="muted">times in the log are UTC (system daemons run without a time zone)</span></div>' +
    '<pre class="out" id="logOut"' + (S.out.log ? "" : " hidden") + ">" + esc(S.out.log || "") + "</pre></div>";
  h += '<div class="card wide"><h2>Diagnostics</h2><div class="btns"><button type="button" id="cfgBtn">Configuration (no password)</button>' +
    '<button type="button" id="genBtn">Generated /etc/sysinit</button></div><pre class="out" id="diagOut"' +
    (S.out.diag ? "" : " hidden") + ">" + esc(S.out.diag || "") + "</pre></div>";
  return h + "</div>";
};
PAGES.maint.after = function () {
  function out(id, t) { el(id).hidden = false; el(id).textContent = t; }
  el("fwUp").onclick = function () {
    var f = el("fwFile").files[0], b = this;
    if (!f) { out("fwOut", "choose an image file first"); return; }
    b.disabled = true; el("fwProg").hidden = false; el("fwProg").value = 0; out("fwOut", "uploading " + f.size + " bytes\u2026");
    upload("fwup", f, function (x) { el("fwProg").value = x; }).then(function (t) {
      out("fwOut", t); el("fwGoBox").hidden = false;
    }).catch(function (e) { out("fwOut", e.message); }).then(function () { b.disabled = false; el("fwProg").hidden = true; });
  };
  el("fwGo").onclick = function () {
    if (!confirm("Write the checked image to flash and reboot?")) return;
    api("fwgo", { body: "1" }).then(function () { waitReboot("Flashing the image; the switch reboots by itself (a few minutes)\u2026"); })
      .catch(function (e) { out("fwOut", e.message); });
  };
  el("fwCancel").onclick = function () {
    api("fwcancel", { body: "1" }).then(function () { el("fwGoBox").hidden = true; out("fwOut", "image removed"); reload(); });
  };
  el("bkGo").onclick = function () { location.href = "cgi-bin/api?a=backup"; };
  el("rsGo").onclick = function () {
    var f = el("rsFile").files[0];
    if (!f) { out("rsOut", "choose a backup file first"); return; }
    if (!confirm("Replace the configuration with this backup and reboot?")) return;
    upload("restore", f).then(function () { waitReboot("Configuration restored; rebooting\u2026"); })
      .catch(function (e) { out("rsOut", e.message); });
  };
  el("pwGo").onclick = function () {
    var a = el("pw1").value, b = el("pw2").value;
    if (a !== b) { el("pwMsg").textContent = "the two fields differ"; return; }
    if (!/^[!-~]{1,63}$/.test(a)) { el("pwMsg").textContent = "1-63 printable ASCII characters, no spaces"; return; }
    el("pwMsg").textContent = "saving\u2026";
    api("passwd", { body: a }).then(function (t) {
      el("pwMsg").textContent = t.trim(); el("pw1").value = el("pw2").value = "";
      if (/^OK password changed/.test(t)) {   /* the old password no longer works: let the browser ask now */
        el("pwMsg").textContent = t.trim() + " - the browser will ask for the new password";
        setTimeout(function () { location.reload(); }, 2000);
      }
    })
      .catch(function (e) { el("pwMsg").textContent = e.message; });
  };
  el("locate").onclick = function () {
    api("locate", { q: "on=" + ((S.info && S.info.locate) ? 0 : 1), body: "1" }).then(reload);
  };
  el("rebootBtn").onclick = function () {
    if (!confirm("Reboot the switch?")) return;
    api("reboot", { body: "1" }).then(function () { waitReboot("Rebooting\u2026"); });
  };
  el("resetBtn").onclick = function () {
    if (prompt("Factory reset erases the configuration. Type RESET to continue.") !== "RESET") return;
    api("reset", { body: "1" }).then(function () {
      banner("warn", "Factory reset; the switch reboots with DHCP (fallback 192.168.1.20), user ubnt / ubnt.");
    });
  };
  el("logBtn").onclick = function () { api("log").then(function (t) { S.out.log = t; out("logOut", t); }); };
  el("cfgBtn").onclick = function () { api("cfg").then(function (t) { S.out.diag = t; out("diagOut", t); }); };
  el("genBtn").onclick = function () { api("gen").then(function (t) { S.out.diag = t; out("diagOut", t); }); };
};
function waitReboot(msg) {
  /* the switch is back after the reboot when info answers with another boot id
     (/proc/sys/kernel/random/boot_id). The id of the current boot is asked at once - the action itself waits 1-2 s
     before rebooting; without ids on both sides the old signs stay: a poll failed, or 10 min passed. */
  var seenDown = false, t0 = Date.now(), boot0 = S.info && S.info.boot;
  banner("warn", msg);
  function poll() {
    setTimeout(function () {
      api("info", { json: true, timeout: 8000 }).then(function (i) {
        var back = boot0 && i.boot ? i.boot !== boot0 : seenDown;
        if (back || Date.now() - t0 > 600000) { location.reload(); return; }
        poll();
      }).catch(function () { seenDown = true; hdrState(true); poll(); });
    }, 4000);
  }
  api("info", { json: true, timeout: 1500 }).then(function (i) { if (i.boot) boot0 = i.boot; }, function () {}).then(poll);
}

/* ------------------------------------------------------------ hints */
var HINTS = {
  "Flow control": "802.3x pause frames. The vendor generator applies it only when the port mode is <b>Auto</b>: with a fixed speed it writes <code>flow_control 0</code>.",
  "Isolate": "Isolated ports do not exchange traffic with each other (driver <code>protected</code>). Off by default.",
  "Storm control": "Per-port ingress rate limits for unknown unicast, unregistered multicast and broadcast, in Kbps (driver <code>rate_in</code>, ACL rule 17). Off by default.",
  "Link": "<b>Reset</b> takes the port link down for 2 s and up again, as the vendor web does (<code>ip link set lanN down/up</code>); with PoE on, the PoE power is cycled too. Not for a disabled port.",
  "Mirroring": "Copies Rx and Tx of the source ports to the target port. One target only, several sources possible.",
  "Jumbo frames": "Maximum frame size 9216 bytes on all ports.",
  "Edge port": "<b>Enable</b>: the port goes to forwarding at once (end device). <b>Auto</b>: edge until a BPDU is seen. <b>Disable</b>: normal port.",
  "Path cost": "0 (vendor default) = automatic: mstpd derives the cost from the link speed.",
  "Management VLAN": "VLAN of the CPU and the admin port. The vendor generator moves both (<code>bridge vlan \u2026 dev eth1</code>, <code>cpu_pvid</code>).",
  "DSCP map": "<b>standard</b>: priority = DSCP \u00bb 3. <b>PTP only</b>: every DSCP maps to 0 and the PTP DSCP to 7.",
  "Trust": "What sets the priority of incoming frames: the 802.1p PCP of tagged frames, the IP DSCP, or the port priority only.",
  "PTP": "PTP frames entering this port get priority 7, and PTP multicast is forwarded only to PTP ports (es5xp-qos).",
  "Flood": "Unknown unicast and multicast are flooded to this port. Off keeps such traffic away from a PTP client.",
  "SSH keys": "Public keys allowed to log in over SSH without the password; written by the vendor generator to /etc/dropbear/authorized_keys."
};
var hintPop = null, hintFor = null;
function closeHint() { if (hintPop && hintPop.parentNode) hintPop.parentNode.removeChild(hintPop); hintPop = null; hintFor = null; }
function openHint(t, key) {
  if (!HINTS[key]) return;
  closeHint();
  hintPop = document.createElement("div"); hintPop.className = "hint-pop";
  hintPop.innerHTML = '<span class="close">\u00d7</span><b>' + esc(key) + "</b> \u2014 " + HINTS[key];
  document.body.appendChild(hintPop); hintFor = key;
  var r = t.getBoundingClientRect(), w = hintPop.offsetWidth, hh = hintPop.offsetHeight, pad = 10;
  var left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad), top = r.bottom + 6;
  if (top + hh > window.innerHeight - pad) top = Math.max(pad, r.top - hh - 6);
  hintPop.style.left = left + "px"; hintPop.style.top = top + "px";
}
document.addEventListener("click", function (ev) {
  var t = ev.target;
  if (hintPop && (t === hintPop || hintPop.contains(t))) { if (t.className === "close") closeHint(); return; }
  while (t && t !== document.body && !(t.dataset && t.dataset.hint)) t = t.parentNode;
  if (!t || !t.dataset || !t.dataset.hint) { closeHint(); return; }
  if (t.dataset.hint === hintFor) { closeHint(); return; }
  openHint(t, t.dataset.hint);
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeHint(); });
window.addEventListener("scroll", closeHint, true);

/* ---------------------------------------------------------- routing */
function render() {
  var p = (location.hash || "#status").slice(1);
  if (!PAGES[p]) p = "status";
  if (S.page !== p && S.auto) { clearInterval(S.auto); S.auto = null; }
  S.page = p;
  var links = document.querySelectorAll("#nav a");
  for (var i = 0; i < links.length; i++) links[i].classList.toggle("on", links[i].getAttribute("href") === "#" + p);
  if (!S.loaded) return;
  var y = window.scrollY;
  el("page").innerHTML = PAGES[p]();
  if (PAGES[p].after) PAGES[p].after();
  window.scrollTo(0, y);
  refreshDirty();
}
window.addEventListener("hashchange", function () {
  closeHint();
  if (el("banner").classList.contains("ok")) banner();   /* a finished "OK" message does not follow to another page */
  render();
});
document.addEventListener("change", onField);
document.addEventListener("input", onField);
el("abApply").onclick = apply;
el("abDiscard").onclick = discard;
el("abShow").onclick = function () { S.showDiff = !S.showDiff; applyBar(); };
window.addEventListener("beforeunload", function (e) { if (nEdits()) { e.preventDefault(); e.returnValue = ""; } });

render();
reload().then(function () {
  if (S.info && S.info.pending != null) {   /* opened while a trial apply waits: this browser reaches the switch */
    S.deadline = Date.now() + S.info.pending * 1000; follow(true);
  }
}).catch(function (e) { el("page").innerHTML = '<div class="note warn">Cannot load: ' + esc(e.message) + "</div>"; hdrState(true); });
