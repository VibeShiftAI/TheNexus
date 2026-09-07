import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import {
  DisplayScaleProvider,
  DisplayScaleControl,
} from "../display-scale.tsx";
test("master scale applies globally, stays bounded, resets, and restores the saved preference", async () => {
  localStorage.setItem("nexus.displayScale", "1.25");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(
          DisplayScaleProvider,
          null,
          createElement(DisplayScaleControl),
        ),
      ),
    );
    assert.equal(
      document.body.style.getPropertyValue("--nexus-display-scale"),
      "1.25",
    );
    await act(async () =>
      container.querySelector('[aria-label="Text and display size"]').click(),
    );
    const larger = document.querySelector(
      '[aria-label="Larger dashboard text"]',
    );
    await act(async () => larger.click());
    assert.equal(localStorage.getItem("nexus.displayScale"), "1.3");
    for (let i = 0; i < 10; i++) await act(async () => larger.click());
    assert.equal(
      document.body.style.getPropertyValue("--nexus-display-scale"),
      "1.5",
    );
    assert.equal(larger.disabled, true);
    await act(async () =>
      document.querySelector('[aria-label="Reset display size"]').click(),
    );
    assert.equal(localStorage.getItem("nexus.displayScale"), "1");
  } finally {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    document.body.style.removeProperty("--nexus-display-scale");
  }
});
