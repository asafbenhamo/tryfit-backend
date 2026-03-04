const express = require("express");
const router = express.Router();
const credits = require("./credits");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "tryfit2026";

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== "Bearer " + ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

router.get("/api/stores", adminAuth, (req, res) => {
  res.json({ stores: credits.listStores() });
});

router.post("/api/stores", adminAuth, (req, res) => {
  const { shop, credits: c, plan } = req.body;
  if (!shop) return res.status(400).json({ error: "Shop required" });
  res.json(credits.createStore(shop, c || 0, plan || "none"));
});

router.delete("/api/stores/:shop", adminAuth, (req, res) => {
  res.json(credits.removeStore(req.params.shop));
});

router.post("/api/credits/add", adminAuth, (req, res) => {
  const { shop, amount, reason } = req.body;
  if (!shop || !amount) return res.status(400).json({ error: "Shop and amount required" });
  res.json(credits.addCreditsToStore(shop, amount, reason));
});

router.post("/api/credits/set", adminAuth, (req, res) => {
  const { shop, credits: c, reason } = req.body;
  if (!shop) return res.status(400).json({ error: "Shop required" });
  res.json(credits.setCreditsForStore(shop, c, reason));
});

router.get("/", (req, res) => {
  res.send(getDashboardHTML());
});

function getDashboardHTML() {
  return '<!DOCTYPE html>' +
'<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
'<title>TryFit Admin</title>' +
'<style>' +
'*{margin:0;padding:0;box-sizing:border-box}' +
'body{font-family:Arial,sans-serif;background:#1a1a2e;color:#eee;padding:20px}' +
'h1{color:#E94560;margin-bottom:20px}h2{color:#E94560;margin:20px 0 10px}' +
'.login-box{max-width:400px;margin:100px auto;background:#16213e;padding:30px;border-radius:12px}' +
'.login-box h1{text-align:center}' +
'.login-box input{width:100%;padding:12px;margin:10px 0;border:none;border-radius:8px;background:#0f3460;color:#eee;font-size:16px}' +
'.login-box button{width:100%;padding:12px;border:none;border-radius:8px;background:#E94560;color:#fff;font-size:16px;cursor:pointer}' +
'.dashboard{display:none}' +
'.stats{display:flex;gap:15px;flex-wrap:wrap;margin-bottom:20px}' +
'.stat-card{background:#16213e;padding:20px;border-radius:12px;min-width:180px;flex:1}' +
'.stat-card .number{font-size:28px;font-weight:bold;color:#E94560}' +
'.stat-card .label{color:#aaa;font-size:14px}' +
'table{width:100%;border-collapse:collapse;background:#16213e;border-radius:12px;overflow:hidden;margin-bottom:20px}' +
'th{background:#0f3460;padding:12px;text-align:left}' +
'td{padding:10px 12px;border-bottom:1px solid #0f3460}' +
'tr:hover{background:#1a1a4e}' +
'.btn{padding:6px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;color:#fff}' +
'.btn-add{background:#27ae60}.btn-set{background:#2980b9}.btn-del{background:#c0392b}' +
'.form-row{display:flex;gap:10px;align-items:center;margin:10px 0;flex-wrap:wrap}' +
'.form-row input,.form-row select{padding:10px;border:none;border-radius:8px;background:#0f3460;color:#eee;font-size:14px}' +
'.form-row input[type=text]{width:250px}.form-row input[type=number]{width:120px}' +
'.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-weight:bold}' +
'.b-high{background:#27ae6033;color:#2ecc71}.b-mid{background:#f39c1233;color:#f1c40f}' +
'.b-low{background:#e7434533;color:#E94560}.b-zero{background:#c0392b33;color:#e74c3c}' +
'.msg{padding:10px;border-radius:8px;margin:10px 0;display:none}' +
'.msg-ok{background:#27ae6033;color:#2ecc71}.msg-err{background:#e7434533;color:#E94560}' +
'</style></head><body>' +
'<div class="login-box" id="L">' +
'<h1>TryFit Admin</h1>' +
'<input type="password" id="pw" placeholder="Password" onkeydown="if(event.key===\'Enter\')doLogin()">' +
'<button onclick="doLogin()">Login</button>' +
'<div class="msg" id="lm"></div></div>' +
'<div class="dashboard" id="D">' +
'<h1>TryFit Admin Dashboard</h1>' +
'<div class="stats" id="st"></div>' +
'<h2>Add Store</h2>' +
'<div class="form-row">' +
'<input type="text" id="ns" placeholder="store.myshopify.com">' +
'<input type="number" id="nc" value="1000">' +
'<select id="np"><option value="starter">Starter</option><option value="growth">Growth</option><option value="pro">Pro</option><option value="business">Business</option></select>' +
'<button class="btn btn-add" onclick="addStore()">Add</button></div>' +
'<div class="msg" id="am"></div>' +
'<h2>Stores</h2>' +
'<table><thead><tr><th>Store</th><th>Credits</th><th>Used</th><th>30d</th><th>Plan</th><th>Actions</th></tr></thead>' +
'<tbody id="tb"></tbody></table>' +
'<h2>Quick Actions</h2>' +
'<div class="form-row">' +
'<input type="text" id="as" placeholder="store.myshopify.com">' +
'<input type="number" id="aa" value="1000">' +
'<button class="btn btn-add" onclick="doAdd()">+Add</button>' +
'<button class="btn btn-set" onclick="doSet()">Set</button></div>' +
'<div class="msg" id="qm"></div></div>' +
'<script>' +
'var T="";var A=location.origin;' +
'function api(m,p,b){var o={method:m,headers:{"Authorization":"Bearer "+T,"Content-Type":"application/json"}};if(b)o.body=JSON.stringify(b);return fetch(A+"/admin"+p,o).then(function(r){return r.json()})}' +
'function doLogin(){T=document.getElementById("pw").value;api("GET","/api/stores").then(function(d){if(d.error){msg("lm",d.error,true);return}document.getElementById("L").style.display="none";document.getElementById("D").style.display="block";load()}).catch(function(){msg("lm","Failed",true)})}' +
'function load(){api("GET","/api/stores").then(function(d){if(d.error)return;var s=d.stores;var tc=0,tu=0,ac=0;s.forEach(function(x){tc+=x.credits;tu+=x.total_used;if(x.credits>0)ac++});' +
'document.getElementById("st").innerHTML="<div class=\\"stat-card\\"><div class=\\"number\\">"+s.length+"</div><div class=\\"label\\">Stores</div></div><div class=\\"stat-card\\"><div class=\\"number\\">"+ac+"</div><div class=\\"label\\">Active</div></div><div class=\\"stat-card\\"><div class=\\"number\\">"+tc.toLocaleString()+"</div><div class=\\"label\\">Credits Left</div></div><div class=\\"stat-card\\"><div class=\\"number\\">"+tu.toLocaleString()+"</div><div class=\\"label\\">Total Try-Ons</div></div>";' +
'var h="";s.forEach(function(x){var b=x.credits>500?"b-high":x.credits>100?"b-mid":x.credits>0?"b-low":"b-zero";' +
'h+="<tr><td>"+x.shop+"</td><td><span class=\\"badge "+b+"\\">"+x.credits.toLocaleString()+"</span></td><td>"+x.total_used.toLocaleString()+"</td><td>"+(x.usage_30d||0)+"</td><td>"+(x.plan||"none")+"</td><td><button class=\\"btn btn-add\\" onclick=\\"qAdd(\'"+x.shop+"\')\">+</button> <button class=\\"btn btn-del\\" onclick=\\"qDel(\'"+x.shop+"\')\">X</button></td></tr>"});' +
'document.getElementById("tb").innerHTML=h||"<tr><td colspan=\\"6\\" style=\\"text-align:center;color:#aaa\\">No stores</td></tr>"})}' +
'function addStore(){var s=document.getElementById("ns").value.trim(),c=parseInt(document.getElementById("nc").value)||0,p=document.getElementById("np").value;if(!s){msg("am","Enter store",true);return}api("POST","/api/stores",{shop:s,credits:c,plan:p}).then(function(d){msg("am",d.message||d.error,!!d.error);load()});}' +
'function doAdd(){var s=document.getElementById("as").value.trim(),a=parseInt(document.getElementById("aa").value)||0;if(!s||!a){msg("qm","Enter store and amount",true);return}api("POST","/api/credits/add",{shop:s,amount:a}).then(function(d){msg("qm",d.message||d.error,!!d.error);load()});}' +
'function doSet(){var s=document.getElementById("as").value.trim(),a=parseInt(document.getElementById("aa").value)||0;if(!s){msg("qm","Enter store",true);return}api("POST","/api/credits/set",{shop:s,credits:a}).then(function(d){msg("qm",d.message||d.error,!!d.error);load()});}' +
'function qAdd(s){var a=prompt("Credits to add to "+s+"?","1000");if(a){document.getElementById("as").value=s;document.getElementById("aa").value=a;doAdd();}}' +
'function qDel(s){if(!confirm("Remove "+s+"?"))return;api("DELETE","/api/stores/"+encodeURIComponent(s)).then(function(d){msg("qm",d.message||d.error,!!d.error);load()});}' +
'function msg(id,t,e){var el=document.getElementById(id);el.textContent=t;el.className="msg "+(e?"msg-err":"msg-ok");el.style.display="block";setTimeout(function(){el.style.display="none"},3000);}' +
'</script></body></html>';
}

module.exports = router;