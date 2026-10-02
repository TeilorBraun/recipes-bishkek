"use strict";

// All text that comes from data files (shop names from OpenStreetMap, recipe lines from
// Wikibooks) is written with textContent only: none of it is ever treated as HTML.

const MAX_KCAL_INPUT = 5000;
const NEAREST_STORES_SHOWN = 8;
const EARTH_RADIUS_M = 6371000;
// Beyond this the "nearest shop" order is no longer trustworthy and the user is told so.
const ROUGH_ACCURACY_M = 300;
const GLOBUS_ONLINE_URL = "https://globus-online.kg/";

const numberFormat = new Intl.NumberFormat("ru");
const kmFormat = new Intl.NumberFormat("ru", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pluralRules = new Intl.PluralRules("ru");
const PORTION_FORMS = { one: "порция", few: "порции", many: "порций", other: "порции" };
const KIND_NAMES = { supermarket: "супермаркет", convenience: "магазин у дома" };

const el = {
  limit: document.getElementById("kcal-limit"),
  kcalMessage: document.getElementById("kcal-message"),
  categoryFilter: document.getElementById("category-filter"),
  dishList: document.getElementById("dish-list"),
  details: document.getElementById("dish-details"),
  locate: document.getElementById("locate"),
  locateMessage: document.getElementById("locate-message"),
  storeList: document.getElementById("store-list"),
  onlySupermarkets: document.getElementById("only-supermarkets"),
  storesDate: document.getElementById("stores-date"),
};

const ALL_CATEGORIES = "all";
const state = { categories: [], selectedCategory: ALL_CATEGORIES, recipes: [], stores: [], bbox: null, selectedDishId: null, map: null, youMarker: null, position: null, storeMarkers: new Map() };

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setMessage(target, text, isProblem = false) {
  target.textContent = text;
  target.classList.toggle("is-problem", isProblem);
}

function portionsText(count) {
  return `${numberFormat.format(count)} ${PORTION_FORMS[pluralRules.select(count)]}`;
}

function kcalText(recipe) {
  return `${recipe.approximate ? "≈ " : ""}${numberFormat.format(recipe.kcal_per_portion)} ккал`;
}

function gramsText(grams) {
  return `${numberFormat.format(grams)} г`;
}

function distanceText(metres) {
  if (metres < 1000) return `${numberFormat.format(Math.round(metres / 10) * 10)} м`;
  return `${kmFormat.format(metres / 1000)} км`;
}

function distanceMetres(a, b) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// ---------- Dishes ----------

function readLimit() {
  const raw = el.limit.value.trim();
  if (raw === "") return { error: "Введите число калорий." };
  if (!/^\d+$/.test(raw)) return { error: "Нужно целое число без знаков и букв, например 500." };
  const value = Number(raw);
  if (value < 1 || value > MAX_KCAL_INPUT) return { error: `Число должно быть от 1 до ${numberFormat.format(MAX_KCAL_INPUT)}.` };
  return { value };
}

function renderCategories(limit) {
  el.categoryFilter.replaceChildren();
  const withinLimit = limit === null ? [] : state.recipes.filter((recipe) => recipe.kcal_per_portion <= limit);
  const chips = [{ id: ALL_CATEGORIES, title: "Все" }, ...state.categories];
  for (const category of chips) {
    const count = category.id === ALL_CATEGORIES
      ? withinLimit.length
      : withinLimit.filter((recipe) => recipe.category === category.id).length;
    const chip = node("button", "chip", `${category.title} ${numberFormat.format(count)}`);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(category.id === state.selectedCategory));
    chip.addEventListener("click", () => {
      state.selectedCategory = category.id;
      renderDishes();
    });
    el.categoryFilter.append(chip);
  }
}

function renderDishes() {
  el.dishList.replaceChildren();
  const limit = readLimit();
  renderCategories(limit.error ? null : limit.value);
  if (limit.error) {
    setMessage(el.kcalMessage, limit.error, true);
    showDetails(null);
    return;
  }
  const inCategory = state.recipes.filter(
    (recipe) => state.selectedCategory === ALL_CATEGORIES || recipe.category === state.selectedCategory,
  );
  const fitting = inCategory.filter((recipe) => recipe.kcal_per_portion <= limit.value);
  if (fitting.length === 0) {
    // Recipes are sorted by calories, so the first one in the section is its lightest.
    const lightest = inCategory[0];
    setMessage(el.kcalMessage, `В этом разделе блюд до ${numberFormat.format(limit.value)} ккал нет. Самое лёгкое: ${lightest.title}, ${kcalText(lightest)}.`);
    showDetails(null);
    return;
  }
  setMessage(el.kcalMessage, "");
  for (const recipe of fitting) {
    const item = node("li");
    const button = node("button", "dish");
    button.type = "button";
    button.setAttribute("aria-pressed", String(recipe.id === state.selectedDishId));
    button.append(node("span", "row-title", recipe.title), node("span", "row-figure", kcalText(recipe)));
    button.addEventListener("click", () => {
      state.selectedDishId = recipe.id;
      renderDishes();
    });
    item.append(button);
    el.dishList.append(item);
  }
  showDetails(fitting.find((recipe) => recipe.id === state.selectedDishId) || null);
}

function showDetails(recipe) {
  el.details.replaceChildren();
  el.details.hidden = !recipe;
  if (!recipe) return;

  el.details.append(node("h3", "", recipe.title));
  el.details.append(node("p", "", `${kcalText(recipe)} на порцию. Продукты ниже — на весь рецепт: ${portionsText(recipe.portions)}.`));

  const table = node("table", "ingredients");
  const headRow = node("tr");
  headRow.append(node("th", "", "Продукт"), node("th", "number", "Сколько"), node("th", "number", "ккал"));
  const head = node("thead");
  head.append(headRow);
  const body = node("tbody");
  for (const line of recipe.ingredients) {
    const row = node("tr");
    row.append(
      node("td", "", line.approx ? `${line.name} ≈` : line.name),
      node("td", "number", gramsText(line.grams)),
      node("td", "number", numberFormat.format(line.kcal)),
    );
    body.append(row);
  }
  table.append(head, body);
  el.details.append(table);

  // Prices are not copied into the page: without a delivery address the shop shows a demo
  // catalogue, so the reader opens the search in their own browser, with their own address.
  const prices = node("p", "", "Цены в Globus Online: ");
  // A product can appear twice in one dish (milk for the cutlets and for the mash): one link is enough.
  const productNames = [...new Set(recipe.ingredients.map((line) => line.name))];
  productNames.forEach((name, index) => {
    const priceLink = node("a", "", name);
    priceLink.href = `${GLOBUS_ONLINE_URL}ru-kg/search?text=${encodeURIComponent(name)}`;
    priceLink.target = "_blank";
    priceLink.rel = "noopener";
    prices.append(priceLink, index < productNames.length - 1 ? ", " : ".");
  });
  prices.append(" Это каталог доставки: укажите на сайте свой адрес, иначе он покажет демо-цены.");
  el.details.append(prices);

  const notes = node("div", "details-notes");
  if (recipe.approximate) {
    const reasons = recipe.ingredients.filter((line) => line.approx).map((line) => `${line.name}: ${line.approx}`);
    if (recipe.portions_note) reasons.push(recipe.portions_note);
    notes.append(node("p", "", `Знак ≈ значит, что цифра приблизительная. ${reasons.join(" ")}`));
  }
  if (recipe.not_counted.length > 0) {
    notes.append(node("p", "", `Не учтено в калориях (соль, специи, вода, зелень без указанного веса, добавки по желанию): ${recipe.not_counted.join("; ")}.`));
  }
  if (recipe.composed) {
    const composed = node("p", "", `Рецепт составлен для этой программы, а не взят из кулинарной книги. ${recipe.composed.note} Сверен с: `);
    recipe.composed.references.forEach((reference, index) => {
      const link = node("a", "", reference.title);
      link.href = reference.url;
      link.target = "_blank";
      link.rel = "noopener";
      composed.append(link, index < recipe.composed.references.length - 1 ? "; " : ".");
    });
    notes.append(composed);
    el.details.append(notes);
    return;
  }
  const source = node("p", "", "Рецепт: ");
  recipe.sources.forEach((item, index) => {
    const link = node("a", "", `Викиучебник, «${item.title.replace("Рецепт:", "")}»`);
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener";
    source.append(link, index < recipe.sources.length - 1 ? "; " : `, ${item.license}.`);
  });
  notes.append(source);
  el.details.append(notes);
}

// ---------- Stores and map ----------

function storeTitle(store) {
  return store.name || "Без названия";
}

function storeNote(store) {
  const parts = [KIND_NAMES[store.kind]];
  if (store.address) parts.push(store.address);
  parts.push(store.chain === "globus" ? "у сети есть онлайн-каталог" : "вариант, ассортимент неизвестен");
  return parts.join(" · ");
}

function popupContent(store) {
  const box = node("div", "popup");
  box.append(node("strong", "", storeTitle(store)));
  box.append(node("span", "", storeNote(store)));
  if (store.hours) {
    box.append(node("br"), node("span", "", `Часы работы: ${store.hours}`));
  }
  if (store.chain === "globus") {
    const link = node("a", "", "Каталог Globus Online");
    link.href = GLOBUS_ONLINE_URL;
    link.target = "_blank";
    link.rel = "noopener";
    box.append(node("br"), link, node("span", "", " — каталог доставки; что лежит на полке этого магазина, он не показывает."));
  }
  return box;
}

function visibleStores() {
  return el.onlySupermarkets.checked ? state.stores.filter((store) => store.kind === "supermarket") : state.stores;
}

function applyStoreFilter() {
  const visible = new Set(visibleStores().map((store) => store.id));
  for (const [id, marker] of state.storeMarkers) {
    if (visible.has(id)) marker.addTo(state.map);
    else marker.remove();
  }
  if (state.position) renderNearest(state.position);
}

function cssColour(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function createMap() {
  const [south, west, north, east] = state.bbox;
  const map = L.map("map", { preferCanvas: true }).fitBounds([[south, west], [north, east]]);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const known = cssColour("--known");
  const unknown = cssColour("--unknown");
  for (const store of state.stores) {
    const isKnown = store.chain === "globus";
    const marker = L.circleMarker([store.lat, store.lon], {
      radius: isKnown ? 7 : store.kind === "supermarket" ? 5 : 3,
      color: isKnown ? known : unknown,
      weight: 1,
      fillColor: isKnown ? known : unknown,
      fillOpacity: isKnown ? 0.9 : 0.75,
      // Without this a click on a shop would also count as "I am here".
      bubblingMouseEvents: false,
    });
    marker.bindPopup(() => popupContent(store));
    state.storeMarkers.set(store.id, marker);
  }
  map.on("click", (event) => setPosition({ lat: event.latlng.lat, lon: event.latlng.lng }, "Точка поставлена вручную."));
  state.map = map;
  applyStoreFilter();
}

function insideBishkek(position) {
  const [south, west, north, east] = state.bbox;
  return position.lat >= south && position.lat <= north && position.lon >= west && position.lon <= east;
}

function setPosition(position, howText) {
  if (state.youMarker) state.youMarker.remove();
  state.youMarker = L.circleMarker([position.lat, position.lon], {
    radius: 9, color: cssColour("--on-accent"), weight: 3, fillColor: cssColour("--you"), fillOpacity: 1, bubblingMouseEvents: false,
  }).addTo(state.map).bindPopup("Вы здесь");

  const outside = !insideBishkek(position);
  setMessage(
    el.locateMessage,
    outside
      ? `${howText} Эта точка за пределами Бишкека, а магазины есть только для Бишкека — расстояния будут большими. Поставьте точку щелчком по карте.`
      : `${howText} Если точка не там — щёлкните по карте в нужном месте.`,
    outside,
  );
  state.position = position;
  renderNearest(position);
  if (!outside) state.map.setView([position.lat, position.lon], 15);
}

function renderNearest(position) {
  const nearest = visibleStores()
    .map((store) => ({ store, metres: distanceMetres(position, store) }))
    .sort((a, b) => a.metres - b.metres)
    .slice(0, NEAREST_STORES_SHOWN);
  el.storeList.replaceChildren();
  for (const { store, metres } of nearest) {
    const item = node("li");
    const button = node("button", "store");
    button.type = "button";
    const note = node("span", "row-note", storeNote(store));
    note.classList.toggle("is-known", store.chain === "globus");
    button.append(node("span", "row-title", storeTitle(store)), node("span", "row-figure", distanceText(metres)), note);
    button.addEventListener("click", () => {
      state.map.setView([store.lat, store.lon], 17);
      state.storeMarkers.get(store.id).openPopup();
      document.getElementById("map").scrollIntoView({ block: "nearest" });
    });
    item.append(button);
    el.storeList.append(item);
  }
}

function locate() {
  if (!("geolocation" in navigator)) {
    setMessage(el.locateMessage, "Этот браузер не умеет определять местоположение. Щёлкните по карте в том месте, где вы находитесь.", true);
    return;
  }
  if (!window.isSecureContext) {
    setMessage(el.locateMessage, "Браузер даёт местоположение только страницам, открытым через localhost или https. Щёлкните по карте в том месте, где вы находитесь.", true);
    return;
  }
  el.locate.disabled = true;
  setMessage(el.locateMessage, "Определяю… Браузер спросит разрешение.");
  navigator.geolocation.getCurrentPosition(
    (result) => {
      el.locate.disabled = false;
      const accuracy = Math.round(result.coords.accuracy);
      const rough = accuracy > ROUGH_ACCURACY_M ? " Это грубо: без GPS компьютер определяет место по сети." : "";
      setPosition(
        { lat: result.coords.latitude, lon: result.coords.longitude },
        `Местоположение определено с точностью около ${distanceText(accuracy)}.${rough}`,
      );
    },
    (error) => {
      el.locate.disabled = false;
      const reasons = {
        1: "Доступ к местоположению не разрешён.",
        2: "Устройство не смогло определить местоположение.",
        3: "Местоположение не определилось за 15 секунд.",
      };
      setMessage(el.locateMessage, `${reasons[error.code] || "Местоположение не определилось."} Щёлкните по карте в том месте, где вы находитесь.`, true);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

// ---------- Start ----------

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ответ ${response.status}`);
  return response.json();
}

async function start() {
  try {
    const [recipes, stores] = await Promise.all([loadJson("data/recipes.json"), loadJson("data/stores.json")]);
    state.recipes = recipes.recipes;
    state.categories = recipes.categories;
    state.stores = stores.stores;
    state.bbox = stores.bbox;
    el.storesDate.textContent = `данные на ${new Date(stores.fetched).toLocaleDateString("ru")}`;
  } catch (error) {
    setMessage(el.kcalMessage, `Не удалось загрузить данные (${error.message}). Страницу нужно открывать через запуск run.cmd, а не двойным щелчком по файлу.`, true);
    el.locate.disabled = true;
    return;
  }
  renderDishes();
  createMap();
  el.limit.addEventListener("input", renderDishes);
  el.locate.addEventListener("click", locate);
  el.onlySupermarkets.addEventListener("change", applyStoreFilter);
}

start();
