/* global document, window, IntersectionObserver */

const sections = document.querySelectorAll(".section-reveal");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12%", threshold: 0.12 },
  );

  for (const section of sections) observer.observe(section);
} else {
  for (const section of sections) section.classList.add("is-visible");
}
