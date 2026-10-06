import type { Page } from "playwright";
import { runScript } from "../browser-scripts";
import type { PageTestContext, TestModule } from "../context";
import { evidence, outcome, type CheckOutcome } from "../outcome";
import { click, locate, sameDestination, settle, spec } from "./helpers";

/** Controls that would complete a purchase. The ecommerce module never activates them. */
export const PURCHASE_ACTION = /\b(place (my )?order|pay( now)?|purchase|buy now|complete (order|purchase)|confirm (order|purchase|payment)|submit (order|payment))\b/i;

export interface EcomSignals {
  productLinks: { qid: string; href: string; text: string }[];
  addToCart: { qid: string; text: string; formMethod: string | null } | null;
  variants: { qid: string; kind: "select" | "radio"; name: string; label: string; options: { value: string; qid: string | null; disabled: boolean }[]; selected: string }[];
  quantity: { qid: string; value: string; max: string | null } | null;
  cartCountText: string | null;
  cartLink: { qid: string; href: string } | null;
  checkout: { qid: string; text: string; tag: string; href: string | null } | null;
  cartQuantity: { qid: string; value: string } | null;
  updateButton: { qid: string; text: string } | null;
  removeControl: { qid: string; text: string } | null;
  emptyCartText: boolean;
  heading: string;
}

/** Detects ecommerce elements and tags them with data-qap ids. Detection only, no interaction. */
const ECOM_SCRIPT = String.raw`() => {
  let n = 0;
  const tag = (el, p) => { if (!el.getAttribute("data-qap")) el.setAttribute("data-qap", "ecom-" + p + "-" + (n++)); return el.getAttribute("data-qap"); };
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const txt = (el) => (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const controls = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[href], [role=button]')).filter(shown);
  const productLinks = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('[class*="product" i] a[href], [itemtype*="Product"] a[href], li.product a[href], [class*="product-card" i] a[href]')) {
    if (!shown(a) || seen.has(a.href) || /cart|checkout|wishlist/i.test(a.href)) continue;
    seen.add(a.href);
    productLinks.push({ qid: tag(a, "plp"), href: a.href, text: txt(a).slice(0, 80) });
  }
  const atc = controls.find((c) => /\badd to (cart|bag|basket)\b/i.test(txt(c)) || (c.name === "add" && c.closest('form[action*="cart" i]')));
  const variants = [];
  for (const s of document.querySelectorAll("select")) {
    const lab = (s.id && document.querySelector('label[for="' + CSS.escape(s.id) + '"]')) || s.closest("label");
    const meta = (s.name + " " + s.id + " " + (lab ? txt(lab) : "")).toLowerCase();
    if (!shown(s) || !/size|colou?r|variant|option|style|material/.test(meta)) continue;
    variants.push({ qid: tag(s, "var"), kind: "select", name: s.name || s.id, label: lab ? txt(lab) : s.name, selected: s.value,
      options: Array.from(s.options).map((o) => ({ value: o.value, qid: null, disabled: o.disabled })) });
  }
  const radioGroups = new Map();
  for (const r of document.querySelectorAll('input[type=radio]')) {
    if (!/size|colou?r|variant|option/i.test(r.name)) continue;
    radioGroups.set(r.name, [...(radioGroups.get(r.name) || []), r]);
  }
  for (const [name, radios] of radioGroups) {
    const checked = radios.find((r) => r.checked);
    variants.push({ qid: tag(radios[0], "rad"), kind: "radio", name, label: name, selected: checked ? checked.value : "",
      options: radios.map((r) => { const target = r.closest("label") || (r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')) || r; return { value: r.value, qid: tag(target, "radopt"), disabled: r.disabled }; }) });
  }
  const qty = Array.from(document.querySelectorAll('input[name*="qty" i], input[name*="quantity" i], input[type=number][id*="quantity" i]')).find(shown);
  const isCart = /\/(cart|basket|bag)(\/|$|\?)/i.test(location.pathname) || !!document.querySelector('form[action*="cart/update" i], [class*="cart-item" i], [class*="line-item" i]');
  const countEl = document.querySelector('[data-cart-count], [class*="cart-count" i], [class*="cart_count" i], [id*="cart-count" i], a[href*="cart" i] [class*="count" i]');
  const cartLink = Array.from(document.querySelectorAll('a[href*="/cart" i], a[href*="basket" i]')).find(shown);
  const checkout = controls.find((c) => /\b(proceed to |go to )?check ?out\b/i.test(txt(c)) && !/\b(place|pay|confirm|complete)\b/i.test(txt(c)));
  const update = controls.find((c) => /\bupdate( cart| basket)?\b/i.test(txt(c)));
  const remove = Array.from(document.querySelectorAll('a[href], button, [role=button], input[type=submit]')).filter(shown)
    .find((c) => /^(remove|delete|×|x)$/i.test(txt(c)) || /remove/i.test(c.getAttribute("aria-label") || "") || /remove/i.test(c.className || ""));
  return {
    productLinks: productLinks.slice(0, 20),
    addToCart: atc && !isCart ? { qid: tag(atc, "atc"), text: txt(atc), formMethod: atc.closest("form") ? (atc.closest("form").getAttribute("method") || "get").toLowerCase() : null } : null,
    variants,
    quantity: qty && !isCart ? { qid: tag(qty, "qty"), value: qty.value, max: qty.getAttribute("max") } : null,
    cartCountText: countEl ? txt(countEl) : null,
    cartLink: cartLink ? { qid: tag(cartLink, "cart"), href: cartLink.href } : null,
    checkout: checkout && isCart ? { qid: tag(checkout, "chk"), text: txt(checkout), tag: checkout.tagName.toLowerCase(), href: checkout.href || null } : null,
    cartQuantity: qty && isCart ? { qid: tag(qty, "cqty"), value: qty.value } : null,
    updateButton: update && isCart ? { qid: tag(update, "upd"), text: txt(update) } : null,
    removeControl: remove && isCart ? { qid: tag(remove, "rm"), text: txt(remove) || remove.getAttribute("aria-label") || "remove" } : null,
    emptyCartText: /your (cart|basket|bag) is empty|no items in (your )?(cart|basket)|cart is currently empty/i.test(document.body.innerText),
    heading: txt(document.querySelector("h1") || document.body).slice(0, 120),
  };
}`;

export function detectEcommerce(page: Page): Promise<EcomSignals> {
  return runScript<EcomSignals>(page, ECOM_SCRIPT);
}

export function hasEcommerce(s: EcomSignals): boolean {
  return !!s.addToCart || s.productLinks.length >= 2 || !!s.checkout || !!s.cartQuantity;
}

const num = (text: string | null) => {
  const m = /\d+/.exec(text ?? "");
  return m ? Number(m[0]) : null;
};

const bodyText = (ctx: PageTestContext) => ctx.session.page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");

export const ecommerceModule: TestModule = {
  id: "ecommerce",
  scope: "page",
  async run(ctx) {
    const page = ctx.session.page;
    const s = (key: string, title: string, steps: string[], expected: string, element = "storefront") =>
      spec("ecommerce", key, { title, section: "Ecommerce", feature: "Ecommerce flow", element, steps, expected, preconditions: "Isolated browser session. Orders are never placed and payment is never submitted.", expectationSource: "DETECTED_FUNCTIONALITY" });
    const results: CheckOutcome[] = [];
    let sig = await detectEcommerce(page);
    if (!hasEcommerce(sig)) {
      return [outcome.notApplicable(s("detect", "Ecommerce functionality", ["Inspect the page for products, cart and checkout controls"], "Ecommerce features work"), "No product listing, add-to-cart, cart or checkout controls were detected on this page.")];
    }

    // 1. Product listing → product detail.
    if (!sig.addToCart && sig.productLinks.length >= 2) {
      const first = sig.productLinks[0];
      const step = s("plp-to-pdp", "Product listing opens a product detail page", ["Click the first product in the listing", "Check that a product page with add-to-cart loads"], "The product page loads and offers add-to-cart", `a → ${first.href}`);
      const nav = page.waitForNavigation({ timeout: ctx.options.navigationTimeoutMs }).catch(() => null);
      await click(locate(ctx, first.qid));
      const response = await nav;
      await settle(ctx, 500);
      if (response && response.status() >= 400) {
        results.push(outcome.fail(step, `Product page returned HTTP ${response.status()}`, [evidence.http("Product page", `${page.url()} → ${response.status()}`)]));
        return results;
      }
      sig = await detectEcommerce(page);
      if (sig.addToCart) results.push(outcome.pass(step, `Opened ${page.url()} with "${sig.addToCart.text}"`, [`URL after click: ${page.url()}`, `Add-to-cart control: "${sig.addToCart.text}"`]));
      else {
        results.push(outcome.warn(step, `Opened ${page.url()} but no add-to-cart control was found there`));
        return results;
      }
    }

    // 2. Variants, size, colour.
    if (sig.addToCart) {
      if (!sig.variants.length) results.push(outcome.notApplicable(s("variants", "Product variants can be selected", ["Find size/colour/variant options"], "Selecting an option updates the selection"), "No size, colour or variant options on this product."));
      for (const v of sig.variants) {
        const option = v.options.find((o) => !o.disabled && o.value && o.value !== v.selected);
        const step = s(`variant:${v.name}`, `Variant "${v.label || v.name}" can be selected`, [`Choose another ${v.label || v.name}`, "Read the selected value"], "The chosen option becomes selected", `${v.kind} ${v.name}`);
        if (!option) {
          results.push(outcome.notApplicable(step, "Only one selectable option."));
          continue;
        }
        if (v.kind === "select") await locate(ctx, v.qid).selectOption(option.value, { timeout: 4_000 }).catch(() => undefined);
        else if (option.qid) await click(locate(ctx, option.qid));
        await settle(ctx, 300);
        const after = (await detectEcommerce(page)).variants.find((x) => x.name === v.name);
        if (after?.selected === option.value) results.push(outcome.pass(step, `Selected "${option.value}"`, [`${v.name}: "${v.selected}" → "${after.selected}"`]));
        else results.push(outcome.fail(step, `After choosing "${option.value}", the selected value is "${after?.selected ?? "unknown"}"`, [evidence.dom("Variant state", JSON.stringify({ before: v.selected, chosen: option.value, after: after?.selected }))]));
      }

      // 3. Quantity.
      sig = await detectEcommerce(page);
      const qtyStep = s("quantity", "Quantity can be changed", ["Set the quantity to 2", "Read the field value"], "The quantity field holds 2", "quantity input");
      if (!sig.quantity) results.push(outcome.notApplicable(qtyStep, "No quantity field on the product page."));
      else if (sig.quantity.max !== null && Number(sig.quantity.max) < 2) results.push(outcome.notApplicable(qtyStep, `Maximum quantity is ${sig.quantity.max}.`));
      else {
        const q = locate(ctx, sig.quantity.qid);
        await q.fill("2", { timeout: 3_000 }).catch(() => undefined);
        const v = await q.inputValue().catch(() => "");
        results.push(v === "2" ? outcome.pass(qtyStep, "Quantity set to 2", ['Field value "2"']) : outcome.fail(qtyStep, `Field value is "${v}" after entering 2`, [evidence.dom("Quantity field", `value="${v}"`)]));
      }

      // 4. Add to cart (session-only; never checks out).
      sig = await detectEcommerce(page);
      const product = sig.heading;
      const before = { count: num(sig.cartCountText), url: page.url() };
      const atcStep = s("add-to-cart", "Add to cart updates the cart", [`Click "${sig.addToCart!.text}"`, "Check the cart count, cart page or confirmation message"], "The product is added (cart count increases, cart opens or a confirmation appears)", `button "${sig.addToCart!.text}"`);
      if (PURCHASE_ACTION.test(sig.addToCart!.text)) {
        results.push(outcome.notExecuted(atcStep, `"${sig.addToCart!.text}" would complete a purchase, so it was not clicked.`));
        return results;
      }
      const nav = page.waitForNavigation({ timeout: 10_000 }).catch(() => null);
      await click(locate(ctx, sig.addToCart!.qid));
      const response = await nav;
      await settle(ctx, 800);
      if (response && response.status() >= 500) {
        results.push(outcome.fail(atcStep, `Add to cart returned HTTP ${response.status()}`, [evidence.http("Add to cart", `${page.url()} → ${response.status()}`)]));
        return results;
      }
      const afterSig = await detectEcommerce(page);
      const text = await bodyText(ctx);
      const changes: string[] = [];
      const afterCount = num(afterSig.cartCountText);
      if (before.count !== null && afterCount !== null && afterCount > before.count) changes.push(`cart count ${before.count} → ${afterCount}`);
      if (before.count === null && afterCount !== null && afterCount > 0) changes.push(`cart count shows ${afterCount}`);
      if (/\/(cart|basket|bag)(\/|$|\?)/i.test(new URL(page.url()).pathname) && page.url() !== before.url) changes.push(`navigated to ${page.url()}`);
      const confirm = /added to (your )?(cart|bag|basket)|item added|has been added/i.exec(text);
      if (confirm) changes.push(`message "${confirm[0]}"`);
      if (!changes.length) {
        const shot = await ctx.capture("After add to cart");
        results.push(outcome.warn(atcStep, "No cart count change, cart page or confirmation was detected after clicking", { evidence: shot ? [shot] : [] }));
        return results;
      }
      const addedShot = await ctx.capture("After add to cart");
      results.push(outcome.pass(atcStep, `Added: ${changes.join("; ")}`, changes, { evidence: addedShot ? [addedShot] : [] }));

      // 5. Cart page shows the product.
      const cartUrl = /\/(cart|basket|bag)(\/|$|\?)/i.test(new URL(page.url()).pathname) ? page.url() : afterSig.cartLink?.href ?? null;
      const cartStep = s("cart-contents", "Cart shows the added product", ["Open the cart", `Look for "${product}"`], "The cart lists the product that was added", "cart page");
      if (!cartUrl) {
        results.push(outcome.notExecuted(cartStep, "No link to the cart page was found."));
        return results;
      }
      if (!sameDestination(page.url(), cartUrl)) await page.goto(cartUrl, { timeout: ctx.options.navigationTimeoutMs }).catch(() => undefined);
      await settle(ctx, 400);
      const cartText = await bodyText(ctx);
      if (product && cartText.toLowerCase().includes(product.toLowerCase())) results.push(outcome.pass(cartStep, `Cart at ${page.url()} lists "${product}"`, [`"${product}" found on the cart page`]));
      else {
        const shot = await ctx.capture("Cart page");
        results.push(outcome.warn(cartStep, `"${product}" was not found on the cart page`, { evidence: shot ? [shot] : [] }));
      }
      await runCartSteps(ctx, s, product, results);
    } else if (sig.cartQuantity || sig.checkout) {
      await runCartSteps(ctx, s, null, results);
    }
    return results;
  },
};

type SpecFn = (key: string, title: string, steps: string[], expected: string, element?: string) => ReturnType<typeof spec>;

/** Cart page: update quantity, navigate to checkout (stopping there), then remove the item. */
async function runCartSteps(ctx: PageTestContext, s: SpecFn, product: string | null, results: CheckOutcome[]) {
  const page = ctx.session.page;
  const cartUrl = page.url();
  let sig = await detectEcommerce(page);

  const updStep = s("cart-update", "Cart quantity can be updated", ["Change the cart quantity to 2", "Apply the update", "Read the quantity again"], "The cart keeps the new quantity", "cart quantity");
  if (!sig.cartQuantity) results.push(outcome.notApplicable(updStep, "No editable quantity in the cart."));
  else {
    const target = sig.cartQuantity.value === "2" ? "3" : "2";
    await locate(ctx, sig.cartQuantity.qid).fill(target, { timeout: 3_000 }).catch(() => undefined);
    const nav = page.waitForNavigation({ timeout: 8_000 }).catch(() => null);
    if (sig.updateButton) await click(locate(ctx, sig.updateButton.qid));
    else await locate(ctx, sig.cartQuantity.qid).press("Enter").catch(() => undefined);
    await nav;
    await settle(ctx, 600);
    sig = await detectEcommerce(page);
    if (sig.cartQuantity?.value === target) results.push(outcome.pass(updStep, `Cart quantity is ${target} after updating`, [`Quantity field after update: ${target}`]));
    else results.push(outcome.fail(updStep, `Cart quantity is "${sig.cartQuantity?.value ?? "missing"}" after setting ${target}`, [evidence.dom("Cart quantity", JSON.stringify({ requested: target, after: sig.cartQuantity?.value ?? null }))]));
  }

  // Checkout navigation: GET navigation is followed; any form submission is intercepted. Nothing is filled in.
  sig = await detectEcommerce(page);
  const chkStep = s("checkout-navigation", "Checkout can be reached (stopping before payment)", ["Click the checkout control with writes blocked", "Confirm the checkout page loads", "Stop: no details are entered and payment is never submitted"], "The checkout page opens", "checkout control");
  if (!sig.checkout) results.push(outcome.notApplicable(chkStep, "No checkout control on the cart page."));
  else if (PURCHASE_ACTION.test(sig.checkout.text)) results.push(outcome.notExecuted(chkStep, `"${sig.checkout.text}" would complete a purchase, so it was not clicked.`));
  else {
    ctx.session.setGuard("writes");
    const nav = page.waitForNavigation({ timeout: ctx.options.navigationTimeoutMs }).catch(() => null);
    await click(locate(ctx, sig.checkout.qid));
    const response = await nav;
    await settle(ctx, 600);
    const blocked = ctx.session.setGuard(false);
    if (blocked.some((b) => b.resourceType === "document")) {
      results.push(outcome.notExecuted(chkStep, `Checkout starts with a form submission (${blocked[0].method} ${blocked[0].url}); it was intercepted and not followed, so the payment step was never approached.`));
    } else if (response && response.status() >= 400) {
      results.push(outcome.fail(chkStep, `Checkout returned HTTP ${response.status()}`, [evidence.http("Checkout", `${page.url()} → ${response.status()}`)]));
    } else if (/checkout/i.test(page.url()) || /checkout/i.test((await detectEcommerce(page)).heading)) {
      const paymentFields = await page.locator('input[autocomplete^="cc-"], input[name*="card" i], iframe[src*="stripe" i]').count().catch(() => 0);
      results.push(outcome.pass(chkStep, `Reached ${page.url()}${paymentFields ? ` (${paymentFields} payment field(s) present and left untouched)` : ""}; stopped before payment`, [`URL after click: ${page.url()}`]));
    } else results.push(outcome.warn(chkStep, `After clicking "${sig.checkout.text}" the browser is at ${page.url()}, which does not look like a checkout page`));
    if (!sameDestination(page.url(), cartUrl)) await page.goto(cartUrl, { timeout: ctx.options.navigationTimeoutMs }).catch(() => undefined);
    await settle(ctx, 300);
  }

  // Remove the item (cart-only action).
  sig = await detectEcommerce(page);
  const rmStep = s("cart-remove", "Item can be removed from the cart", ["Click the remove control", "Check the cart"], "The item disappears or the cart reports it is empty", "remove control");
  if (!sig.removeControl) results.push(outcome.notApplicable(rmStep, "No remove control in the cart."));
  else {
    const nav = page.waitForNavigation({ timeout: 8_000 }).catch(() => null);
    await click(locate(ctx, sig.removeControl.qid));
    await nav;
    await settle(ctx, 600);
    const text = await bodyText(ctx);
    const after = await detectEcommerce(page);
    const gone = (product && !text.toLowerCase().includes(product.toLowerCase())) || after.emptyCartText || !after.cartQuantity;
    if (gone) results.push(outcome.pass(rmStep, after.emptyCartText ? "Cart reports it is empty" : "The item is no longer listed", [after.emptyCartText ? "Empty-cart message shown" : `"${product ?? "item"}" no longer on the cart page`]));
    else results.push(outcome.fail(rmStep, "The item is still in the cart after clicking remove", [evidence.dom("Cart after remove", text.slice(0, 1500))]));
  }
}
