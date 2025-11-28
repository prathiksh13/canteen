import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import fs from "fs";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const users = [];
const menuItems = [];
const orders = [];
const analyticsSnapshots = [];
let tokenCounter = 1;
let maxPreparing = 5;
const sessions = new Map();

function seedMenu() {
  const seed = [
    { name: "Idly", category: "breakfast", price: 25, veg: true },
    { name: "Dosa", category: "breakfast", price: 40, veg: true },
    { name: "Samosa", category: "snacks", price: 20, veg: true },
    { name: "Puff", category: "snacks", price: 30, veg: true },
    { name: "Tea", category: "drinks", price: 12, veg: true },
    { name: "Coffee", category: "drinks", price: 18, veg: true },
    { name: "Egg Puff", category: "snacks", price: 35, veg: false }
  ];
  seed.forEach(s => menuItems.push({ id: uuidv4(), available: true, ...s }));
}

function loadUsersFromFile() {
  try {
    const raw = fs.readFileSync("data/users.json", "utf-8");
    const arr = JSON.parse(raw);
    arr.forEach(u => {
      const id = uuidv4();
      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = hashPassword(u.password || "", salt);
      users.push({ id, name: u.name || "User", role: u.role || "student", email: u.email || null, phone: u.phone || null, rollNumber: u.rollNumber || null, passwordHash, salt, createdAt: new Date().toISOString() });
    });
  } catch (e) {}
}

function hashPassword(password, salt) {
  const h = crypto.pbkdf2Sync(password, salt, 10000, 32, "sha256");
  return h.toString("hex");
}

function createToken(userId) {
  const token = uuidv4();
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

function authUser(req) {
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.*)$/i);
  if (!m) return null;
  const token = m[1];
  const sess = sessions.get(token);
  if (!sess) return null;
  const user = users.find(u => u.id === sess.userId);
  return user || null;
}

function nowHourKey(d = new Date()) {
  const k = d.toISOString().slice(0, 13);
  return k;
}

function getTrendingByHour(hourKey) {
  const counts = {};
  orders.forEach(o => {
    const k = o.createdHourKey;
    if (k === hourKey) {
      o.items.forEach(it => {
        counts[it.itemId] = (counts[it.itemId] || 0) + it.qty;
      });
    }
  });
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return ranked;
}

function recommendForUser(userId, budget) {
  const hourKey = nowHourKey();
  const trending = getTrendingByHour(hourKey);
  const userOrders = orders.filter(o => o.userId === userId);
  const histIds = {};
  const histCats = {};
  userOrders.forEach(o => {
    o.items.forEach(it => {
      histIds[it.itemId] = (histIds[it.itemId] || 0) + it.qty;
      const mi = menuItems.find(m => m.id === it.itemId);
      if (mi) histCats[mi.category] = (histCats[mi.category] || 0) + it.qty;
    });
  });
  const catPref = Object.entries(histCats).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const items = menuItems.filter(m => m.available);
  const scored = items.map(m => {
    const catScore = catPref.includes(m.category) ? 1 : 0;
    const trendScore = trending.includes(m.id) ? 1 : 0;
    const budgetScore = budget ? (m.price <= budget ? 1 : 0) : 0.5;
    const s = 0.5 * catScore + 0.3 * trendScore + 0.2 * budgetScore;
    return { item: m, score: s };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map(x => x.item);
}

function parseAssistantQuery(q) {
  const x = q.toLowerCase();
  const res = { maxPrice: null, spicy: false, filling: false, veg: null };
  const m = x.match(/under\s*(\d+)/);
  if (m) res.maxPrice = parseInt(m[1]);
  if (x.includes("spicy")) res.spicy = true;
  if (x.includes("filling")) res.filling = true;
  if (x.includes("veg")) res.veg = true;
  if (x.includes("non-veg") || x.includes("nonveg")) res.veg = false;
  return res;
}

function assistantSuggest(q) {
  const p = parseAssistantQuery(q);
  let items = menuItems.filter(m => m.available);
  if (p.maxPrice != null) items = items.filter(m => m.price <= p.maxPrice);
  if (p.veg != null) items = items.filter(m => m.veg === p.veg);
  const boost = i => {
    let s = 0;
    if (p.spicy && (i.name.toLowerCase().includes("masala") || i.name.toLowerCase().includes("puff") || i.name.toLowerCase().includes("samosa"))) s += 1;
    if (p.filling && (i.category === "breakfast" || i.name.toLowerCase().includes("dosa"))) s += 1;
    return s;
  };
  const ranked = items.map(i => ({ item: i, score: boost(i) + (p.maxPrice ? 1 : 0) })).sort((a, b) => b.score - a.score);
  return ranked.slice(0, 6).map(r => r.item);
}

app.get("/api/menu", (req, res) => {
  const { category } = req.query;
  let items = menuItems;
  if (category) items = items.filter(m => m.category === category);
  res.json(items);
});

app.post("/api/auth/signup", (req, res) => {
  const { name, email, phone, password, role, rollNumber } = req.body || {};
  if (!name || !password || (!email && !phone)) return res.status(400).json({ error: "missing_fields" });
  const exists = users.find(u => (email && u.email === email) || (phone && u.phone === phone));
  if (exists) return res.status(409).json({ error: "user_exists" });
  const id = uuidv4();
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  const user = { id, name, role: role || "student", email: email || null, phone: phone || null, rollNumber: rollNumber || null, passwordHash, salt, createdAt: new Date().toISOString() };
  users.push(user);
  const token = createToken(id);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, phone: user.phone, rollNumber: user.rollNumber } });
});

app.post("/api/auth/login", (req, res) => {
  const { email, phone, password } = req.body || {};
  const user = users.find(u => (email && u.email === email) || (phone && u.phone === phone));
  if (!user) return res.status(404).json({ error: "not_found" });
  const ok = hashPassword(password || "", user.salt) === user.passwordHash;
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });
  const token = createToken(user.id);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, phone: user.phone } });
});

app.get("/api/auth/me", (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  res.json({ id: u.id, name: u.name, role: u.role, email: u.email, phone: u.phone });
});

app.post("/api/auth/logout", (req, res) => {
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.*)$/i);
  if (m) sessions.delete(m[1]);
  res.json({ ok: true });
});

app.patch("/api/menu/:id", (req, res) => {
  const { id } = req.params;
  const idx = menuItems.findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: "not_found" });
  const allowed = ["name", "category", "price", "veg", "available"];
  const next = { ...menuItems[idx] };
  Object.keys(req.body || {}).forEach(k => {
    if (allowed.includes(k)) next[k] = req.body[k];
  });
  menuItems[idx] = next;
  io.emit("inventory:update", next);
  res.json(next);
});

app.get("/api/orders", (req, res) => {
  const { userId, status } = req.query;
  let list = orders;
  const u = authUser(req);
  if (u && (u.role === "staff" || u.role === "admin") && !userId) {
    // staff/admin see all unless a specific userId is requested
  } else if (userId) {
    list = list.filter(o => o.userId === userId);
  } else if (u) {
    list = list.filter(o => o.userId === u.id);
  } else {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (status) list = list.filter(o => o.status === status);
  res.json(list);
});

app.post("/api/orders", (req, res) => {
  const { userId, items, specialInstructions, budget, paymentMethod } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "invalid_items" });
  const priceItems = items.map(it => {
    const mi = menuItems.find(m => m.id === it.itemId);
    if (!mi) return null;
    return { itemId: mi.id, qty: Math.max(1, it.qty || 1), price: mi.price };
  }).filter(Boolean);
  if (priceItems.length === 0) return res.status(400).json({ error: "no_valid_items" });
  const totalAmount = priceItems.reduce((a, c) => a + c.qty * c.price, 0);
  const hourKey = nowHourKey();
  const preparingCount = orders.filter(o => o.status === "preparing").length;
  const basePrep = 10;
  const delay = preparingCount >= maxPreparing ? (preparingCount - maxPreparing + 1) * 5 : 0;
  const eta = basePrep + delay;
  const u = authUser(req);
  const order = {
    id: uuidv4(),
    userId: (u && u.id) || userId || "guest",
    items: priceItems,
    totalAmount,
    status: "placed",
    specialInstructions: specialInstructions || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tokenNumber: tokenCounter++,
    eta,
    prepaid: paymentMethod === "online",
    paymentMethod: paymentMethod === "online" ? "online" : "cash",
    messages: [],
    createdHourKey: hourKey
  };
  orders.push(order);
  io.emit("order:new", order);
  res.json(order);
});

app.patch("/api/orders/:id/status", (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  const allowed = ["accepted", "preparing", "ready", "completed", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "invalid_status" });
  const u = authUser(req);
  if (!u || (u.role !== "staff" && u.role !== "admin")) return res.status(403).json({ error: "forbidden" });
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: "not_found" });
  const next = { ...orders[idx], status, updatedAt: new Date().toISOString() };
  orders[idx] = next;
  io.emit("order:update", next);
  res.json(next);
});

app.post("/api/orders/:id/message", (req, res) => {
  const { id } = req.params;
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "missing_text" });
  const u = authUser(req);
  if (!u || (u.role !== "staff" && u.role !== "admin")) return res.status(403).json({ error: "forbidden" });
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: "not_found" });
  const msg = { from: u.role, text, at: new Date().toISOString() };
  const next = { ...orders[idx], messages: [...(orders[idx].messages || []), msg], updatedAt: new Date().toISOString() };
  orders[idx] = next;
  io.emit("order:message", { orderId: id, message: msg });
  res.json(next);
});

app.get("/api/analytics/summary", (req, res) => {
  const { range } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const from = range === "7d" ? new Date(Date.now() - 7 * 86400000) : range === "30d" ? new Date(Date.now() - 30 * 86400000) : new Date(new Date().setHours(0,0,0,0));
  const list = orders.filter(o => new Date(o.createdAt) >= from);
  const totalOrders = list.length;
  const totalRevenue = list.reduce((a, c) => a + c.totalAmount, 0);
  const avgOrderValue = totalOrders ? totalRevenue / totalOrders : 0;
  const activeUsers = new Set(list.map(o => o.userId)).size;
  res.json({ date: today, totalOrders, totalRevenue, avgOrderValue, activeUsers });
});

app.get("/api/analytics/revenue", (req, res) => {
  const { range } = req.query;
  const from = range === "7d" ? new Date(Date.now() - 7 * 86400000) : range === "30d" ? new Date(Date.now() - 30 * 86400000) : new Date(new Date().setHours(0,0,0,0));
  const list = orders.filter(o => new Date(o.createdAt) >= from);
  const totalRevenue = list.filter(o => o.status !== "cancelled").reduce((a,c)=>a+c.totalAmount,0);
  const cancelledRevenue = list.filter(o => o.status === "cancelled").reduce((a,c)=>a+c.totalAmount,0);
  const netRevenue = totalRevenue - cancelledRevenue;
  res.json({ totalRevenue, cancelledRevenue, netRevenue });
});

app.get("/api/analytics/top-items", (req, res) => {
  const { limit } = req.query;
  const counts = {};
  orders.forEach(o => o.items.forEach(it => counts[it.itemId] = (counts[it.itemId] || 0) + it.qty));
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, parseInt(limit || 5)).map(([itemId, count]) => {
    const m = menuItems.find(x => x.id === itemId);
    return { itemId, name: m ? m.name : itemId, count };
  });
  res.json(ranked);
});

app.get("/api/analytics/orders-per-hour", (req, res) => {
  const buckets = {};
  orders.forEach(o => {
    const k = o.createdHourKey;
    buckets[k] = buckets[k] || { hour: k, orders: 0 };
    buckets[k].orders += 1;
  });
  const arr = Object.values(buckets).sort((a, b) => a.hour.localeCompare(b.hour));
  res.json(arr);
});

app.get("/api/analytics/reports", (req, res) => {
  const { from, to, type } = req.query;
  const f = from ? new Date(from) : new Date(0);
  const t = to ? new Date(to) : new Date();
  const list = orders.filter(o => new Date(o.createdAt) >= f && new Date(o.createdAt) <= t);
  res.setHeader("Content-Type", "text/csv");
  if (type === "orders") {
    const rows = ["id,userId,itemsCount,totalAmount,status,createdAt"].concat(list.map(o => `${o.id},${o.userId},${o.items.reduce((a,c)=>a+c.qty,0)},${o.totalAmount},${o.status},${o.createdAt}`));
    res.send(rows.join("\n"));
  } else if (type === "item_sales") {
    const counts = {};
    list.forEach(o => o.items.forEach(it => {
      const m = menuItems.find(x => x.id === it.itemId);
      const k = m ? m.name : it.itemId;
      counts[k] = counts[k] || { name: k, qty: 0, revenue: 0 };
      counts[k].qty += it.qty;
      counts[k].revenue += it.qty * it.price;
    }));
    const rows = ["name,qtySold,revenue"].concat(Object.values(counts).map(x => `${x.name},${x.qty},${x.revenue}`));
    res.send(rows.join("\n"));
  } else {
    const buckets = {};
    list.forEach(o => {
      const h = o.createdHourKey;
      buckets[h] = buckets[h] || { slot: h, orders: 0, revenue: 0 };
      buckets[h].orders += 1;
      buckets[h].revenue += o.totalAmount;
    });
    const rows = ["slot,ordersCount,revenue"].concat(Object.values(buckets).map(x => `${x.slot},${x.orders},${x.revenue}`));
    res.send(rows.join("\n"));
  }
});

app.get("/api/ai/recommendations", (req, res) => {
  const { userId, budget } = req.query;
  const items = recommendForUser(userId || "guest", budget ? parseInt(budget) : null);
  res.json(items);
});

app.post("/api/ai/assistant", (req, res) => {
  const { query } = req.body || {};
  const items = assistantSuggest(query || "");
  res.json(items);
});

app.post("/api/staff/capacity", (req, res) => {
  const { max } = req.body || {};
  const n = parseInt(max);
  if (!n || n < 1) return res.status(400).json({ error: "invalid" });
  const u = authUser(req);
  if (!u || (u.role !== "staff" && u.role !== "admin")) return res.status(403).json({ error: "forbidden" });
  maxPreparing = n;
  res.json({ maxPreparing });
});

io.on("connection", socket => {
  socket.on("disconnect", () => {});
});

seedMenu();
loadUsersFromFile();

const port = process.env.PORT || 3001;
server.listen(port, () => {});
