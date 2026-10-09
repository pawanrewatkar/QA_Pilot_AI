import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small, deterministic website used by the crawler and engine integration tests.
 * It contains working components and a few deliberate defects (404 link, 500 link,
 * malformed mailto, tabs that do not switch). Every non-GET request is recorded so tests
 * can prove that guarded form testing never submitted anything.
 */
export interface FixtureSite {
  origin: string;
  /** Same server reached through a different hostname, used as an "external" site. */
  externalOrigin: string;
  writes: { method: string; url: string }[];
  close(): Promise<void>;
}

const layout = (title: string, body: string, extraHead = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} | Fixture Co</title>
<meta name="description" content="${title} page of the fixture site">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  .menu { display: none; } .menu.open { display: block; }
  @media (min-width: 800px) { .menu { display: block; } #menu-toggle { display: none; } }
  [role=tabpanel][hidden] { display: none; }
  .slide { display: none; } .slide.active { display: block; }
  #dialog { display: none; position: fixed; inset: 20%; background: #fff; border: 1px solid #000; } #dialog.open { display: block; }
</style>${extraHead}</head>
<body>
<header>
  <a href="/" class="logo">Fixture Co</a>
  <button id="menu-toggle" class="menu-toggle" aria-expanded="false" aria-controls="main-menu" aria-label="Open menu">☰</button>
  <nav aria-label="Main"><ul id="main-menu" class="menu">
    <li><a href="/about">About</a></li><li><a href="/services">Services</a></li><li><a href="/blog">Blog</a></li>
    <li><a href="/contact">Contact</a></li><li><a href="/login">Login</a></li><li><a href="/logout">Logout</a></li>
  </ul></nav>
  <a href="/cart" class="cart-link">Cart (<span class="cart-count">CARTCOUNT</span>)</a>
  <form role="search" action="/search" method="get"><input type="search" name="q" aria-label="Search" maxlength="40"><button type="submit">Go</button></form>
</header>
<main>${body}</main>
<footer>
  <a href="/privacy">Privacy</a> <a href="/missing-page">Old page</a> <a href="/server-error">Status</a>
  <a href="mailto:hello@example.com">Email us</a> <a href="mailto:not-an-email">Broken email</a> <a href="tel:+15550100">Call</a>
  <a href="EXTERNAL/ext">Partner</a>
</footer>
<script>
  const t = document.getElementById("menu-toggle"); const m = document.getElementById("main-menu");
  t.addEventListener("click", () => { const open = t.getAttribute("aria-expanded") !== "true"; t.setAttribute("aria-expanded", String(open)); m.classList.toggle("open", open); });
</script>
</body></html>`;

const WORKING_TABS = `
<div role="tablist" aria-label="Plans">
  <button role="tab" id="tab-a" aria-selected="true" aria-controls="panel-a">Basic</button>
  <button role="tab" id="tab-b" aria-selected="false" aria-controls="panel-b" tabindex="-1">Pro</button>
</div>
<div role="tabpanel" id="panel-a">Basic plan details</div>
<div role="tabpanel" id="panel-b" hidden>Pro plan details</div>
<script>
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const select = (tab) => { tabs.forEach((x) => { const on = x === tab; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1;
    document.getElementById(x.getAttribute("aria-controls")).hidden = !on; }); tab.focus(); };
  tabs.forEach((tab, i) => { tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") select(tabs[(i + 1) % tabs.length]); }); });
</script>`;

const pages: Record<string, (ext: string) => string> = {
  "/": () =>
    layout(
      "Home",
      `<h1>Welcome to Fixture Co</h1>
      <a class="btn btn-primary" href="/pricing">See pricing</a>
      <a href="/redirect-about">About (old link)</a>
      <a href="/files/guide.pdf">Download the guide</a>
      ${WORKING_TABS}
      <details><summary>What is Fixture Co?</summary><p>A test website.</p></details>
      <button aria-haspopup="dialog" aria-controls="dialog" id="open-dialog">Watch demo</button>
      <div id="dialog" role="dialog" aria-modal="true" aria-label="Demo"><p>Demo video</p><button class="close" aria-label="Close">×</button></div>
      <div class="carousel" aria-roledescription="carousel">
        <div class="slide active" aria-roledescription="slide">One</div><div class="slide" aria-roledescription="slide">Two</div>
        <button class="carousel-control-next" aria-label="Next slide">›</button>
      </div>
      <label for="region">Region</label><select id="region" name="region"><option value="">Choose</option><option value="eu">Europe</option><option value="us">United States</option></select>
      <script>
        const d = document.getElementById("dialog");
        document.getElementById("open-dialog").addEventListener("click", () => d.classList.add("open"));
        d.querySelector(".close").addEventListener("click", () => d.classList.remove("open"));
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") d.classList.remove("open"); });
        const slides = [...document.querySelectorAll(".slide")]; let i = 0;
        document.querySelector(".carousel-control-next").addEventListener("click", () => { slides[i].classList.remove("active"); i = (i + 1) % slides.length; slides[i].classList.add("active"); });
      </script>`,
    ),
  "/about": () => layout("About us", "<h1>About us</h1><p>Our story.</p>"),
  "/services": () => layout("Services", "<h1>Our services</h1><p>Consulting.</p>"),
  "/privacy": () => layout("Privacy", "<h1>Privacy policy</h1>"),
  "/pricing": () => layout("Pricing", `<h1>Pricing</h1><div class="price">$10</div><div class="price">$20</div><div class="price">$30</div>`),
  "/hidden-from-nav": () => layout("Hidden", "<h1>Only in the sitemap</h1>"),
  "/private": () => layout("Private", "<h1>Private</h1>"),
  "/faq": () => layout("FAQ", `<h1>Frequently asked questions</h1>${[1, 2, 3, 4].map((n) => `<details><summary>Question ${n}</summary><p>Answer ${n}</p></details>`).join("")}`),
  "/contact": () =>
    layout(
      "Contact",
      `<h1>Contact us</h1>
      <form action="/contact" method="post" id="contact-form">
        <label for="name">Name</label><input id="name" name="name" required>
        <label for="email">Email</label><input id="email" name="email" type="email" required>
        <label for="phone">Phone</label><input id="phone" name="phone" type="tel" pattern="[0-9 ]{7,20}">
        <label for="message">Message</label><textarea id="message" name="message" required maxlength="500"></textarea>
        <button type="submit">Send message</button>
      </form>`,
    ),
  "/login": () =>
    layout("Login", `<h1>Sign in</h1><form action="/login" method="post"><label for="u">Email</label><input id="u" name="username" type="email" required><label for="p">Password</label><input id="p" name="password" type="password" required><button type="submit">Sign in</button></form>`),
  "/blog": () =>
    layout(
      "Blog",
      `<h1>Blog</h1>${[1, 2, 3].map((n) => `<article><h2><a href="/blog/post-${n}">Post ${n}</a></h2></article>`).join("")}
      <nav class="pagination" aria-label="Pagination"><a href="/blog?page=2" rel="next">Next</a></nav>`,
    ),
  "/blog?page=2": () => layout("Blog page 2", "<h1>Blog</h1><article><h2>Older post</h2></article>"),
  "/invalid-pattern": () =>
    layout("Invalid pattern", `<h1>Callback</h1><form action="/callback" method="post"><label for="tel">Phone</label><input id="tel" name="tel" type="tel" pattern="[0-9+ ()-]{7,20}"><button type="submit">Call me</button></form>`),
  "/blog/post-1": () =>
    layout(
      "First post",
      `<nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/blog">Blog</a></li><li aria-current="page">First post</li></ol></nav><article><h1>First post</h1></article>`,
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"First post"}</script>`,
    ),
  "/blog/post-2": () => layout("Second post", "<article><h1>Second post</h1></article>"),
  "/blog/post-3": () => layout("Third post", "<article><h1>Third post</h1></article>"),
  "/ui-issues": () =>
    layout(
      "UI issues",
      `<h1>Layout problems</h1>
      <p>This page contains deliberate, measurable layout defects.</p>
      <div style="width: 2400px; height: 20px; background: #ccc">Too wide banner</div>
      <img src="/missing.png" alt="Missing picture" width="120" height="80">
      <img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'><rect width='200' height='100' fill='red'/></svg>" width="100" height="100">
      <button style="width: 60px; overflow: hidden; white-space: nowrap">Subscribe to our newsletter today</button>
      <div style="position: relative; height: 40px"><a href="/about" id="covered">Hidden link</a><div style="position: absolute; inset: 0; background: #fff">Overlay box</div></div>
      <script src="/missing.js"></script>`,
    ),
  "/about-company": () =>
    layout(
      "About the company",
      `<h1>About Fixture Co</h1>
      <p>Fixture Co builds reliable testing tools for modern teams.</p>
      <h2>Our mission</h2>
      <p>We help teams ship quality software faster with automated checks.</p>
      <h2>Our history</h2>
      <p>The company was founded in 2015 by two enginers in Berlin.</p>
      <p>We are hiring talented people in every department right now.</p>
      <p>We are hiring talented people in every department right now.</p>
      <a class="btn" href="/contact">Book a demo</a>`,
    ),
  "/shop": () =>
    layout(
      "Shop",
      `<h1>Shop</h1>
      <ul class="products">
        <li class="product-card"><a href="/products/widget">Widget</a><span class="price">$5</span></li>
        <li class="product-card"><a href="/products/gadget">Gadget</a><span class="price">$9</span></li>
      </ul>`,
    ),
  "/products/gadget": () => layout("Gadget", `<h1>Gadget</h1><span class="price">$9</span>`),
  // Client-side sorting, used by the External Test Case Testing acceptance test.
  "/catalog": () =>
    layout(
      "Catalog",
      `<h1>Catalog</h1>
      <label for="sort">Sort by</label>
      <select id="sort"><option value="featured">Featured</option><option value="asc">Price: Low to High</option><option value="desc">Price: High to Low</option></select>
      <ul id="catalog">
        <li class="item"><span class="name">Lamp</span> <span class="price">$30</span></li>
        <li class="item"><span class="name">Mug</span> <span class="price">$10</span></li>
        <li class="item"><span class="name">Desk</span> <span class="price">$20</span></li>
      </ul>
      <script>
        document.getElementById("sort").addEventListener("change", (e) => {
          const list = document.getElementById("catalog");
          const items = [...list.children];
          const price = (li) => Number(li.querySelector(".price").textContent.replace("$", ""));
          if (e.target.value === "featured") return;
          items.sort((a, b) => (e.target.value === "asc" ? price(a) - price(b) : price(b) - price(a))).forEach((li) => list.appendChild(li));
        });
      </script>`,
    ),
  "/checkout": () =>
    layout(
      "Checkout",
      `<h1>Checkout</h1>
      <form action="/checkout/pay" method="post">
        <label for="cc">Card number</label><input id="cc" name="cardnumber" autocomplete="cc-number">
        <label for="cvc">CVC</label><input id="cvc" name="cvc" autocomplete="cc-csc">
        <button type="submit">Pay now</button>
      </form>`,
    ),
  "/products/widget": () =>
    layout(
      "Widget",
      `<h1>Widget</h1><span class="price">$5</span>
      <form action="/cart/add" method="post" class="product-form">
        <input type="hidden" name="sku" value="widget">
        <label for="size">Size</label><select id="size" name="size"><option value="S">Small</option><option value="M">Medium</option><option value="L">Large</option></select>
        <label for="color">Color</label><select id="color" name="color"><option value="red">Red</option><option value="blue">Blue</option></select>
        <label for="qty">Quantity</label><input id="qty" name="quantity" type="number" min="1" max="10" value="1">
        <button type="submit" class="add-to-cart">Add to cart</button>
      </form>`,
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>`,
    ),
  "/broken-tabs": () =>
    layout(
      "Broken tabs",
      `<h1>Broken tabs</h1><div role="tablist"><button role="tab" aria-selected="true" aria-controls="p1">One</button><button role="tab" aria-selected="false" aria-controls="p2">Two</button></div>
      <div role="tabpanel" id="p1">Panel one</div><div role="tabpanel" id="p2" hidden>Panel two</div>`,
    ),
  "/ext": () => "<!doctype html><title>Partner</title><h1>Partner site</h1>",
};

interface CartItem {
  sku: string;
  name: string;
  size: string;
  color: string;
  qty: number;
}

function readCart(cookie: string | undefined): CartItem[] {
  const m = /(?:^|;s*)cart=([^;]+)/.exec(cookie ?? "");
  try {
    return m ? (JSON.parse(decodeURIComponent(m[1])) as CartItem[]) : [];
  } catch {
    return [];
  }
}

function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });
}

/** Reference document for /about-company (Markdown; differs from the page on purpose). */
export const ABOUT_REFERENCE_MD = `# About Fixture Co

Fixture Co builds reliable testing tools for modern teams.

## Our mission

We help teams ship quality software faster with automated checks.

## Our history

The company was founded in 2015 by two engineers in Berlin.

Today we serve customers in more than forty countries.
`;

export async function startFixtureSite(): Promise<FixtureSite> {
  const writes: { method: string; url: string }[] = [];
  let origin = "";
  let externalOrigin = "";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    if (req.method !== "GET" && req.method !== "HEAD") writes.push({ method: req.method ?? "?", url: url.pathname });
    const cart = readCart(req.headers.cookie);
    const cartCount = cart.reduce((n, i) => n + i.qty, 0);
    if (req.method === "POST" && url.pathname.startsWith("/cart/")) {
      return void readBody(req).then((form) => {
        if (url.pathname === "/cart/add") cart.push({ sku: form.get("sku") ?? "?", name: form.get("sku") === "widget" ? "Widget" : "Item", size: form.get("size") ?? "", color: form.get("color") ?? "", qty: Number(form.get("quantity") ?? 1) });
        if (url.pathname === "/cart/update") cart.forEach((item, i) => { const q = form.get(`qty-${i}`); if (q) item.qty = Number(q); });
        if (url.pathname === "/cart/remove") cart.splice(Number(form.get("index") ?? 0), 1);
        res.writeHead(303, { location: "/cart", "set-cookie": `cart=${encodeURIComponent(JSON.stringify(cart))}; Path=/` });
        res.end();
      });
    }
    if (url.pathname === "/cart") {
      const rows = cart.map((item, i) => `<li class="cart-item"><span class="name">${item.name}</span> (${item.size}, ${item.color})
        <form action="/cart/update" method="post" style="display:inline"><label for="q${i}">Qty</label><input id="q${i}" name="qty-${i}" type="number" value="${item.qty}"><button type="submit">Update cart</button></form>
        <form action="/cart/remove" method="post" style="display:inline"><input type="hidden" name="index" value="${i}"><button type="submit" aria-label="Remove ${item.name}">Remove</button></form></li>`).join("");
      const body = cart.length ? `<h1>Your cart</h1><ul>${rows}</ul><a class="btn" href="/checkout">Proceed to checkout</a>` : `<h1>Your cart</h1><p>Your cart is empty.</p>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(layout("Cart", body).replace("CARTCOUNT", String(cartCount)));
    }
    const send = (status: number, body: string, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    switch (url.pathname) {
      case "/robots.txt":
        return send(200, `User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n`, "text/plain");
      case "/sitemap.xml":
        return send(200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/hidden-from-nav</loc></url><url><loc>${origin}/about</loc></url><url><loc>${origin}/faq</loc></url><url><loc>${origin}/products/widget</loc></url><url><loc>${origin}/private</loc></url></urlset>`, "application/xml");
      case "/redirect-about":
        res.writeHead(301, { location: "/about" });
        return res.end();
      case "/server-error":
        return send(500, "<h1>Internal error</h1>");
      case "/logout":
        return send(200, layout("Logged out", "<h1>Logged out</h1>"));
      case "/files/guide.pdf":
        return send(200, "%PDF-1.4\n% fixture guide\n", "application/pdf", { "content-disposition": 'attachment; filename="guide.pdf"' });
      case "/search": {
        const q = url.searchParams.get("q") ?? "";
        return send(200, layout("Search", `<h1>Search results</h1><p>Results for ${q.replace(/[<>&"']/g, "")}</p>`));
      }
    }
    const render = pages[url.pathname + url.search] ?? pages[url.pathname];
    if (!render) return send(404, layout("Not found", "<h1>Page not found</h1>"));
    send(200, render(externalOrigin).replace(/EXTERNAL/g, externalOrigin).replace("CARTCOUNT", String(cartCount)));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  externalOrigin = `http://localhost:${port}`;
  return {
    origin,
    externalOrigin,
    writes,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
