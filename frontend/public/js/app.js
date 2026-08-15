/**
 * Site bootstrap: navigation, demo launch, health indicator.
 */

import { api } from "./api.js";
import { DemoExperience } from "./demo.js";

const demoRoot = document.getElementById("demo-root");
const demoStage = document.getElementById("demo-stage");
const demo = new DemoExperience(demoRoot, demoStage);

// Launch demo from any CTA.
document.querySelectorAll("[data-action=launch-demo]").forEach((btn) =>
  btn.addEventListener("click", () => {
    closeMobileNav();
    demo.open();
  }),
);
document.querySelectorAll("[data-action=exit-demo]").forEach((btn) =>
  btn.addEventListener("click", () => demo.close()),
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !demoRoot.hidden) demo.close();
});

// Mobile navigation.
const navToggle = document.querySelector(".nav-toggle");
const mobileNav = document.querySelector(".mobile-nav");
function closeMobileNav() {
  mobileNav.hidden = true;
  navToggle.setAttribute("aria-expanded", "false");
}
navToggle.addEventListener("click", () => {
  const open = mobileNav.hidden;
  mobileNav.hidden = !open;
  navToggle.setAttribute("aria-expanded", String(open));
});
mobileNav.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeMobileNav));

// Footer health indicator — quiet proof the backend is real.
api
  .health()
  .then((h) => {
    document.getElementById("footer-health").textContent = `API ${h.status} · ${h.mode}`;
  })
  .catch(() => {
    document.getElementById("footer-health").textContent = "API unreachable";
  });
