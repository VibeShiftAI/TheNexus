// Offline capture. PLAYWRIGHT_MODULE can point to an existing Playwright installation.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {createRequire} = require("node:module");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fromDashboard = createRequire(path.resolve(__dirname, "../../dashboard/package.json"));
const React = fromDashboard("react");
const {renderToStaticMarkup} = fromDashboard("react-dom/server");
const lucide = fromDashboard("lucide-react");
const root = path.resolve(__dirname, "../..");
const dir = path.join(root, "docs/design/2026-11-25-decision-other-and-chat/screens");
const read = file => fs.readFileSync(path.join(__dirname, file), "utf8");
const source = JSON.parse(read("source.json"));
const names = ["FileCheck2","Pencil","ShieldCheck","FileCode","Download","ListTree","ThumbsUp","Undo2","MessageSquare",
  "Bot","Plus","History","X","CircleCheck","Send","Info","ListChecks","ChevronRight"];
const icons = Object.fromEntries(names.map(name =>
  [name, renderToStaticMarkup(React.createElement(lucide[name], {className:"icon", "aria-hidden":true, strokeWidth:1.7}))]));
const ownAnswer = "Show a demo slot only when someone volunteers.";
const ownNote = "Start with screenshots when uploads are ready.";

async function capture(page, prefix, state, width) {
  const stage = page.locator(".decisions");
  const filename = prefix + "-" + state + ".png";
  const metrics = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight
  }));
  assert.equal(metrics.width, width, "Content extends beyond " + filename);
  const custom = stage.locator(".own");
  const note = stage.locator(".note p");
  if (state === "after") {
    assert.equal(await custom.innerText(), ownAnswer);
    assert.equal(await note.innerText(), ownNote);
    assert.equal(await stage.locator('[data-item="D9"] .answer b').innerText(), "Later");
  } else {
    assert.equal(await custom.count(), 0);
    assert.equal(await stage.getByRole("button", {name: "Other Write your own answer."}).count(), 2);
  }
  await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
  await page.mouse.move(0, 0);
  await page.screenshot({path:path.join(dir, filename), fullPage:true, animations:"disabled"});
  console.log(filename, metrics.width + "x" + metrics.height, await stage.locator(".progress").innerText());
}

async function run() {
  const browser = await chromium.launch({channel:"chrome", headless:true});
  try {
    for (const surface of ["document", "chat"]) {
      for (const [device, width, height] of [["desktop",1440,900],["phone",393,852]]) {
        const page = await browser.newPage({viewport:{width, height}, deviceScaleFactor:1});
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        // Serve only this in-memory page and its existing local dashboard font.
        await page.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin !== "http://fixture.invalid") return route.abort();
          if (url.pathname === "/") {
            return route.fulfill({contentType:"text/html; charset=utf-8",
              body:'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Decision questions</title><style>' +
                read("mock.css") + '</style><main></main><script>window.fixture=' + JSON.stringify({surface,source,icons}) +
                ';<\/script><script>' + read("mock.js") + '<\/script></html>'});
          }
          if (/^\/dashboard\/tmp\/.+\.woff2$/.test(url.pathname))
            return route.fulfill({path:path.join(root, url.pathname),contentType:"font/woff2"});
          return route.abort();
        });
        await page.goto("http://fixture.invalid/");
        await page.evaluate(() => document.fonts.ready);
        assert(await page.evaluate(() => document.fonts.check('14px Geist')));
        const prefix = surface + "-" + device;
        const demo = page.locator('[data-item="D8"]');
        const uploads = page.locator('[data-item="D9"]');
        if (surface === "chat") await capture(page, prefix, "before", width);
        await demo.locator("[data-option=custom]").click();
        if (surface === "document") await capture(page, prefix, "before", width);
        assert(await demo.getByRole("button", {name:"Save answer"}).isDisabled());
        await demo.getByRole("textbox", {name:"Your answer"}).fill(ownAnswer);
        await demo.getByRole("button", {name:"Save answer"}).click();
        // Other supports the same optional note affordance.
        assert(await demo.getByRole("button", {name:"Add a note"}).isVisible());
        await uploads.locator("[data-option=later]").click();
        await uploads.getByRole("button", {name:"Add a note"}).click();
        await uploads.getByRole("textbox", {name:"Note (optional)"}).fill(ownNote);
        await uploads.getByRole("button", {name:"Save note"}).click();
        if (surface === "chat") {
          await page.getByRole("button", {name:"Send 2 answers"}).click();
          assert.equal(await page.locator(".progress").innerText(),"2 of 3 sent");
          assert(await page.getByRole("button", {name:"Answer",exact:true}).isVisible());
        }
        await capture(page, prefix, "after", width);
        if (surface === "chat") {
          const composer = page.getByRole("textbox", {name:"Message Praxis"});
          await composer.fill("I still want to think about the showcase.");
          await page.getByRole("button", {name:"Send message"}).click();
          assert.equal(await page.locator("#replies p").innerText(), "I still want to think about the showcase.");
          assert.equal(await page.locator(".progress").innerText(), "2 of 3 sent");
          const remaining = page.locator('[data-item="D10"]');
          await remaining.getByRole("button", {name:"Answer"}).click();
          assert(await remaining.locator("[data-option=custom]").isVisible());
          await remaining.locator("[data-option=keep]").click();
          await page.getByRole("button", {name:"Send 1 answer"}).click();
          assert.equal(await page.locator(".progress").innerText(), "3 of 3 sent");
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
