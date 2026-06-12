const CHEVRON_DOWN = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M172.5 142a7.485 7.485 0 0 1-5.185-2.073L100 75.808l-67.315 64.12c-2.998 2.846-7.74 2.744-10.606-.234a7.454 7.454 0 0 1 .235-10.565l72.5-69.057a7.524 7.524 0 0 1 10.371 0l72.5 69.057a7.455 7.455 0 0 1 .235 10.565A7.503 7.503 0 0 1 172.5 142z"></path></svg>`;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === "className") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value != null) node.setAttribute(key, value);
  });
  (Array.isArray(children) ? children : [children]).forEach((child) => {
    if (child == null) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

function renderHero(hero) {
  return el("section", { className: "hero" }, [
    el("div", { className: "hero__bg" }, [
      el("img", { src: hero.image, alt: hero.imageAlt, fetchpriority: "high" }),
    ]),
    el("div", { className: "hero__overlay" }),
    el("div", { className: "hero__content" }, [
      el("h1", { className: "hero__title" }, hero.title),
      el("h2", { className: "hero__subtitle" }, hero.subtitle),
      el("p", { className: "hero__tagline" }, hero.tagline),
    ]),
  ]);
}

function renderServiceCard(item) {
  const bullets = item.bullets.map((text) => el("li", {}, el("p", {}, text)));
  const listChildren = item.intro
    ? [el("p", { className: "service-card__intro" }, item.intro), el("ul", { className: "service-card__list" }, bullets)]
    : [el("ul", { className: "service-card__list" }, bullets)];

  return el("article", { className: "service-card" }, [
    el("div", { className: "service-card__box" }, [
      el("div", { className: "service-card__number-wrap" }, [
        el("div", { className: "service-card__number" }, item.number),
      ]),
      el("h3", { className: "service-card__title" }, item.title),
      ...listChildren,
      el("a", { className: "btn-more", href: item.buttonHref, "aria-label": item.buttonLabel }, [
        item.buttonLabel,
        el("span", { html: CHEVRON_DOWN }),
      ]),
    ]),
  ]);
}

function renderServices(services) {
  return el("section", { className: "services" }, [
    el("div", { className: "section-inner" }, [
      el("h2", { className: "services__heading" }, services.heading),
    ]),
    el("div", { className: "services__strip" }, [
      el("div", { className: "services__bg" }, [
        el("img", { src: services.backgroundImage, alt: services.backgroundAlt }),
      ]),
      el("div", { className: "services__grid" }, services.items.map(renderServiceCard)),
    ]),
  ]);
}

function renderCta(cta) {
  return el("section", { className: "cta" }, [
    el("div", { className: "cta__bg" }, [
      el("img", { src: cta.backgroundImage, alt: cta.backgroundAlt }),
    ]),
    el("div", { className: "cta__content" }, [
      el("h2", { className: "cta__heading" }, cta.heading),
      el("a", { className: "btn-primary", href: cta.buttonHref }, cta.buttonLabel),
    ]),
  ]);
}

function renderBio(bio) {
  return el("section", { className: "bio" }, [
    el("div", { className: "bio__inner" }, [
      el("div", { className: "bio__image" }, [
        el("img", { src: bio.image, alt: bio.imageAlt, loading: "lazy" }),
      ]),
      el("h2", { className: "bio__heading" }, bio.heading),
      el("div", { className: "bio__text" }, bio.paragraphs.map((text) => el("p", {}, text))),
    ]),
  ]);
}

function renderStory(story) {
  return el("section", { className: "story" }, [
    el("div", { className: "story__bg" }, [
      el("img", { src: story.backgroundImage, alt: story.backgroundAlt }),
    ]),
    el("div", { className: "story__box" }, [
      el("h2", { className: "story__heading" }, story.heading),
      el("div", { className: "story__text" }, story.paragraphs.map((text) => el("p", {}, text))),
    ]),
  ]);
}

function renderInfo(location) {
  const { office, appointments } = location;
  return el("section", { className: "info-section" }, [
    el("div", { className: "info-grid" }, [
      el("div", { className: "info-block" }, [
        el("p", { className: "info-block__heading" }, office.heading),
        el("p", { className: "info-block__line" }, office.addressLine1),
        el("p", { className: "info-block__line" }, office.addressLine2),
        el("p", { className: "info-block__text" }, office.description),
      ]),
      el("div", { className: "info-block" }, [
        el("p", { className: "info-block__heading" }, appointments.heading),
        ...appointments.schedule.map((line) => el("p", { className: "info-block__schedule" }, line)),
        el("p", { className: "info-block__schedule" }, appointments.hours),
        el("p", { className: "info-block__text" }, appointments.note),
      ]),
    ]),
  ]);
}

function renderSocial(social) {
  return el("section", { className: "social-section" }, [
    el("h2", { className: "social-section__heading" }, social.heading),
    el("ul", { className: "social-links" }, social.links.map((link) =>
      el("li", {}, el("a", { href: link.href, target: "_blank", rel: "noreferrer noopener", "aria-label": link.label }, [
        el("img", { src: link.image, alt: link.label, width: "36", height: "36" }),
      ]))
    )),
  ]);
}

function renderNav(navigation) {
  return el("nav", { className: "site-nav", "aria-label": "Site" }, [
    el("ul", {}, navigation.map((item) =>
      el("li", {}, el("a", {
        href: item.href,
        className: item.current ? "is-current" : "",
        ...(item.current ? { "aria-current": "page" } : {}),
      }, item.label))
    )),
  ]);
}

function renderFooter(footer) {
  return el("footer", { className: "site-footer" }, [
    el("p", {}, footer.addressLine1),
    el("p", {}, footer.addressLine2),
    el("p", {}, footer.phone),
    el("p", {}, el("a", { href: footer.mapHref, target: "_blank", rel: "noreferrer noopener" }, footer.mapLabel)),
    el("p", { className: "site-footer__copyright" }, footer.copyright),
    el("div", { className: "site-footer__social" }, [
      el("a", { href: footer.social.href, target: "_blank", "aria-label": footer.social.label }, [
        el("img", { src: footer.social.image, alt: footer.social.label, width: "20", height: "20" }),
      ]),
    ]),
  ]);
}

async function init() {
  const response = await fetch("content.json");
  const data = await response.json();

  document.title = data.meta.title;

  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", data.meta.description);

  const main = document.getElementById("site-main");
  main.replaceChildren(
    renderHero(data.hero),
    renderServices(data.services),
    renderCta(data.cta),
    renderBio(data.bio),
    renderStory(data.story),
    renderInfo(data.location),
    renderSocial(data.social)
  );

  const navEl = document.getElementById("site-nav");
  navEl.replaceChildren(...renderNav(data.navigation).childNodes);

  const footerEl = document.getElementById("site-footer");
  footerEl.replaceChildren(...renderFooter(data.footer).childNodes);
}

init().catch((err) => {
  console.error("Failed to load site content:", err);
  document.body.insertAdjacentHTML("beforeend", '<p style="padding:2rem;text-align:center;">Unable to load content. Please serve this site from a local web server.</p>');
});
