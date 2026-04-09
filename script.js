/* Get references to DOM elements */
const categoryFilter = document.getElementById("categoryFilter");
const productSearch = document.getElementById("productSearch");
const productsContainer = document.getElementById("productsContainer");
const showMoreProductsButton = document.getElementById("showMoreProducts");
const selectedProductsList = document.getElementById("selectedProductsList");
const clearSelectedProductsButton = document.getElementById("clearSelectedProducts");
const generateRoutineButton = document.getElementById("generateRoutine");
const directionToggleButton = document.getElementById("directionToggle");
const chatForm = document.getElementById("chatForm");
const chatWindow = document.getElementById("chatWindow");
const userInput = document.getElementById("userInput");

const INITIAL_PRODUCT_LIMIT = 6;
const SELECTED_PRODUCTS_STORAGE_KEY = "loreal-selected-products";
const DIRECTION_STORAGE_KEY = "loreal-direction";
const SESSION_API_KEY_STORAGE_KEY = "loreal-session-openai-key";

/* Store selected products and currently visible products */
let selectedProducts = [];
let visibleProductsById = {};
let expandedDescriptions = new Set();
let allProducts = [];
let currentFilteredProducts = [];
let visibleProductsCount = INITIAL_PRODUCT_LIMIT;
let currentSearchTerm = "";
let chatHistory = [];
let lastGeneratedRoutine = "";

const BEAUTY_TOPICS = [
  "routine",
  "skincare",
  "haircare",
  "makeup",
  "fragrance",
  "cleanser",
  "moisturizer",
  "serum",
  "sunscreen",
  "hair",
  "skin",
  "beauty",
  "acne",
  "retinol",
  "spf",
  "lipstick",
  "foundation",
  "mascara",
];

/* Show initial placeholder until user selects a category */
productsContainer.innerHTML = `
  <div class="placeholder-message">
    Loading products...
  </div>
`;

/* Load product data from JSON file */
async function loadProducts() {
  if (window.PRODUCTS_DATA && Array.isArray(window.PRODUCTS_DATA.products)) {
    return window.PRODUCTS_DATA.products;
  }

  const response = await fetch("products.json");

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading products.json`);
  }

  const data = await response.json();

  if (!Array.isArray(data.products)) {
    throw new Error("Invalid products.json format: missing products array.");
  }

  return data.products;
}

/* Build a unique ID for each product so we can toggle it safely */
function getProductId(product) {
  return `${encodeURIComponent(product.name)}-${encodeURIComponent(product.brand)}`;
}

/* Normalize text values for safer comparisons */
function normalizeValue(value) {
  return String(value).trim().toLowerCase();
}

/* Detect RTL language characters so mixed-language content still reads naturally */
function hasRtlCharacters(text) {
  return /[\u0590-\u08FF]/.test(text);
}

/* Check if a product is currently selected */
function isSelected(productId) {
  return selectedProducts.some((product) => getProductId(product) === productId);
}

/* Check if description is visible for a product */
function isDescriptionExpanded(productId) {
  return expandedDescriptions.has(productId);
}

/* Keep only the fields we want to send to the API */
function getProductsForPrompt(products) {
  return products.map((product) => ({
    name: product.name,
    brand: product.brand,
    category: product.category,
    description: product.description,
  }));
}

/* Save selected products so they persist after page reload */
function saveSelectedProducts() {
  localStorage.setItem(
    SELECTED_PRODUCTS_STORAGE_KEY,
    JSON.stringify(selectedProducts)
  );
}

/* Restore selected products from localStorage */
function loadSelectedProducts() {
  const storedProducts = localStorage.getItem(SELECTED_PRODUCTS_STORAGE_KEY);

  if (!storedProducts) {
    return [];
  }

  try {
    const parsedProducts = JSON.parse(storedProducts);
    return Array.isArray(parsedProducts) ? parsedProducts : [];
  } catch (error) {
    return [];
  }
}

/* Send chat requests to Cloudflare Worker (not directly to OpenAI) */
async function requestWorkerCompletion(messages, temperature, options = {}) {
  const workerEndpoint = window.WORKER_API_URL;

  if (!workerEndpoint) {
    return requestDirectOpenAICompletion(messages, temperature, options);
  }

  const response = await fetch(workerEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages,
      temperature,
      useWebSearch: Boolean(options.useWebSearch),
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const workerMessage = data?.error || data?.message || "Worker request failed.";
    throw new Error(workerMessage);
  }

  const content = data?.choices?.[0]?.message?.content;
  const citations = Array.isArray(data?.citations) ? data.citations : [];

  if (!content) {
    throw new Error("No response content returned from Worker.");
  }

  return {
    content,
    citations,
  };
}

/* Resolve API key from config or ask once for this browser session */
function getSessionOpenAIKey() {
  const configuredKey = window.OPENAI_API_KEY;

  if (configuredKey) {
    return configuredKey;
  }

  const sessionKey = sessionStorage.getItem(SESSION_API_KEY_STORAGE_KEY);

  if (sessionKey) {
    return sessionKey;
  }

  const enteredKey = window.prompt(
    "Paste your OpenAI API key to use the chatbot for this session only:"
  );

  if (!enteredKey) {
    return "";
  }

  sessionStorage.setItem(SESSION_API_KEY_STORAGE_KEY, enteredKey.trim());
  return enteredKey.trim();
}

/* Fallback: call OpenAI directly when Worker URL is not configured */
async function requestDirectOpenAICompletion(messages, temperature, options = {}) {
  const apiKey = getSessionOpenAIKey();

  if (!apiKey) {
    throw new Error(
      "Missing WORKER_API_URL and OpenAI API key. Add one in secrets.js or provide it in the session prompt."
    );
  }

  if (options.useWebSearch) {
    const webResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        tools: [{ type: "web_search_preview" }],
        input: messages,
        temperature,
      }),
    });

    const webData = await webResponse.json();

    if (!webResponse.ok) {
      const errorMessage = webData?.error?.message || "OpenAI web search request failed.";
      throw new Error(errorMessage);
    }

    const content = webData.output_text || "";

    if (!content) {
      throw new Error("No response content returned from OpenAI.");
    }

    return {
      content,
      citations: [],
    };
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages,
      temperature,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMessage = data?.error?.message || "OpenAI request failed.";
    throw new Error(errorMessage);
  }

  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("No response content returned from OpenAI.");
  }

  return {
    content,
    citations: [],
  };
}

/* Ask Cloudflare Worker to generate a routine from selected products */
async function generateRoutineFromProducts(products) {
  const selectedProductsJson = JSON.stringify(getProductsForPrompt(products), null, 2);

  return requestWorkerCompletion(
    [
      {
        role: "system",
        content:
          "You are a helpful beauty routine assistant. Build a clear routine from the selected products. Use sections for Morning and Night when possible. Keep it beginner-friendly and concise.",
      },
      {
        role: "user",
        content: `Create a personalized skincare/beauty routine using ONLY these selected products:\n\n${selectedProductsJson}\n\nReturn:\n1) Recommended order of use\n2) Short reason for each step\n3) Simple usage tips (frequency/time of day).`,
      },
    ],
    0.7
  );
}

/* Decide if a user message is related to routine or beauty topics */
function isBeautyRelatedQuestion(message) {
  const normalizedMessage = normalizeValue(message);

  return BEAUTY_TOPICS.some((topic) => normalizedMessage.includes(topic));
}

/* Draw a user/assistant message in the chat window */
function appendChatMessage(role, text, citations = []) {
  const messageDiv = document.createElement("div");
  messageDiv.className = `chat-message ${role}`;
  const isRtlText = hasRtlCharacters(text);

  if (isRtlText) {
    messageDiv.setAttribute("dir", "rtl");
  }

  const label = role === "user" ? "You" : "Advisor";
  messageDiv.innerHTML = `
    <p class="chat-label">${label}</p>
    <p class="chat-text"></p>
  `;

  messageDiv.querySelector(".chat-text").textContent = text;

  if (citations.length > 0) {
    const citationList = document.createElement("ul");
    citationList.className = "chat-citations";

    citations.forEach((citation) => {
      const listItem = document.createElement("li");
      const link = document.createElement("a");

      link.href = citation.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = citation.title || citation.url;

      listItem.appendChild(link);
      citationList.appendChild(listItem);
    });

    messageDiv.appendChild(citationList);
  }

  chatWindow.appendChild(messageDiv);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* Ask follow-up response from Worker using full conversation history */
async function getFollowUpResponse(userMessage) {
  if (!lastGeneratedRoutine) {
    return "Please generate a routine first, then ask follow-up questions.";
  }

  if (!isBeautyRelatedQuestion(userMessage)) {
    return "I can help with your generated routine and beauty topics like skincare, haircare, makeup, and fragrance. Please ask a question in that area.";
  }

  return requestWorkerCompletion(chatHistory, 0.6, { useWebSearch: true });
}

/* Apply both category filter and keyword product search together */
function applyActiveFilters() {
  if (allProducts.length === 0) {
    return;
  }

  const selectedCategory = categoryFilter.value;
  const shouldShowAll = normalizeValue(selectedCategory) === "all";
  const normalizedQuery = normalizeValue(currentSearchTerm);

  const categoryFilteredProducts = shouldShowAll
    ? allProducts
    : allProducts.filter(
        (product) => normalizeValue(product.category) === normalizeValue(selectedCategory)
      );

  const fullyFilteredProducts = normalizedQuery
    ? categoryFilteredProducts.filter((product) => {
        const searchableText = normalizeValue(
          `${product.name} ${product.brand} ${product.category} ${product.description}`
        );
        return searchableText.includes(normalizedQuery);
      })
    : categoryFilteredProducts;

  visibleProductsCount = INITIAL_PRODUCT_LIMIT;
  displayProducts(fullyFilteredProducts);
}

/* Apply and persist UI text direction (LTR/RTL) */
function setDirection(direction) {
  const normalizedDirection = direction === "rtl" ? "rtl" : "ltr";
  document.documentElement.setAttribute("dir", normalizedDirection);
  document.documentElement.setAttribute(
    "lang",
    normalizedDirection === "rtl" ? "ar" : "en"
  );
  localStorage.setItem(DIRECTION_STORAGE_KEY, normalizedDirection);
  directionToggleButton.textContent = normalizedDirection === "rtl" ? "EN" : "AR";
}

function loadSavedDirection() {
  const savedDirection = localStorage.getItem(DIRECTION_STORAGE_KEY);

  if (savedDirection) {
    return savedDirection;
  }

  return "rtl";
}

/* Render selected products list area */
function renderSelectedProducts() {
  if (selectedProducts.length === 0) {
    selectedProductsList.innerHTML = `
      <p class="selected-empty">No products selected yet.</p>
    `;
    clearSelectedProductsButton.style.display = "none";
    return;
  }

  clearSelectedProductsButton.style.display = "inline-flex";

  selectedProductsList.innerHTML = selectedProducts
    .map((product) => {
      const productId = getProductId(product);

      return `
        <button type="button" class="selected-pill" data-remove-id="${productId}">
          <img
            src="${product.image}"
            alt="${product.name}"
            class="selected-pill-image"
            loading="lazy"
            onerror="this.style.display='none'"
          >
          ${product.name}
          <span class="remove-pill" aria-hidden="true">×</span>
        </button>
      `;
    })
    .join("");
}

/* Show or hide the "Show More" button depending on remaining products */
function updateShowMoreButton() {
  const hasMoreProducts = currentFilteredProducts.length > visibleProductsCount;
  showMoreProductsButton.style.display = hasMoreProducts ? "inline-flex" : "none";
}

/* Create HTML for displaying product cards */
function displayProducts(products) {
  currentFilteredProducts = products;

  if (products.length === 0) {
    productsContainer.innerHTML = `
      <div class="placeholder-message">
        No products found for this category yet.
      </div>
    `;
    visibleProductsById = {};
    updateShowMoreButton();
    return;
  }

  visibleProductsById = {};
  const productsToRender = products.slice(0, visibleProductsCount);

  productsContainer.innerHTML = productsToRender
    .map((product) => {
      const productId = getProductId(product);
      const selectedClass = isSelected(productId) ? "selected" : "";
      const detailsClass = isDescriptionExpanded(productId)
        ? "description-visible"
        : "";
      const detailsButtonLabel = isDescriptionExpanded(productId)
        ? "Hide details"
        : "View details";
      const detailsExpanded = isDescriptionExpanded(productId) ? "true" : "false";
      const descriptionId = `desc-${product.id}`;

      visibleProductsById[productId] = product;

      return `
        <article
          class="product-card ${selectedClass} ${detailsClass}"
          data-product-id="${productId}"
          role="button"
          tabindex="0"
          aria-pressed="${isSelected(productId)}"
        >
          <img
            src="${product.image}"
            alt="${product.name}"
            loading="lazy"
            onerror="this.style.opacity='0.35'; this.alt='Image unavailable';"
          >
          <div class="product-info">
            <h3>${product.name}</h3>
            <p>${product.brand}</p>
            <button
              type="button"
              class="details-toggle"
              data-details-id="${productId}"
              aria-expanded="${detailsExpanded}"
              aria-controls="${descriptionId}"
            >
              ${detailsButtonLabel}
            </button>
            <p id="${descriptionId}" class="product-description">${product.description}</p>
          </div>
        </article>
      `;
    })
    .join("");

  updateShowMoreButton();
}

/* Add or remove a product from selected list */
function toggleProduct(product) {
  const productId = getProductId(product);
  const existingIndex = selectedProducts.findIndex(
    (item) => getProductId(item) === productId
  );

  if (existingIndex >= 0) {
    selectedProducts.splice(existingIndex, 1);
  } else {
    selectedProducts.push(product);
  }

  renderSelectedProducts();
  saveSelectedProducts();
}

/* Show or hide product description */
function toggleDescription(productId) {
  if (expandedDescriptions.has(productId)) {
    expandedDescriptions.delete(productId);
  } else {
    expandedDescriptions.add(productId);
  }
}

/* Filter and display products when category changes */
categoryFilter.addEventListener("change", async (e) => {
  try {
    if (allProducts.length === 0) {
      allProducts = await loadProducts();
    }

    applyActiveFilters();
  } catch (error) {
    productsContainer.innerHTML = `
      <div class="placeholder-message">
        Could not filter products: ${error.message}
      </div>
    `;
  }
});

/* Filter products while typing keywords */
productSearch.addEventListener("input", (e) => {
  currentSearchTerm = e.target.value;
  applyActiveFilters();
});

/* Toggle between LTR and RTL layout modes */
directionToggleButton.addEventListener("click", () => {
  const currentDirection = document.documentElement.getAttribute("dir") || "ltr";
  const nextDirection = currentDirection === "rtl" ? "ltr" : "rtl";
  setDirection(nextDirection);
});

/* Load and display products on first page load */
async function initializeProducts() {
  try {
    allProducts = await loadProducts();
    applyActiveFilters();
  } catch (error) {
    const localFileHint =
      window.location.protocol === "file:"
        ? "Open this project with Live Server (or any local server) instead of opening index.html directly."
        : "Check that products.json exists and is valid JSON.";

    productsContainer.innerHTML = `
      <div class="placeholder-message">
        Could not load products: ${error.message}<br>${localFileHint}
      </div>
    `;
  }
}

/* Toggle product when user clicks a product card */
productsContainer.addEventListener("click", (e) => {
  const detailsToggle = e.target.closest("[data-details-id]");

  if (detailsToggle) {
    const productId = detailsToggle.dataset.detailsId;
    toggleDescription(productId);
    displayProducts(currentFilteredProducts);
    return;
  }

  const productCard = e.target.closest(".product-card");

  if (!productCard) {
    return;
  }

  const productId = productCard.dataset.productId;
  const product = visibleProductsById[productId];

  if (!product) {
    return;
  }

  toggleProduct(product);
  displayProducts(currentFilteredProducts);
});

/* Let keyboard users select cards using Enter or Space */
productsContainer.addEventListener("keydown", (e) => {
  if (e.target.closest("[data-details-id]")) {
    return;
  }

  const productCard = e.target.closest(".product-card");

  if (!productCard) {
    return;
  }

  if (e.key !== "Enter" && e.key !== " ") {
    return;
  }

  e.preventDefault();
  const productId = productCard.dataset.productId;
  const product = visibleProductsById[productId];

  if (!product) {
    return;
  }

  toggleProduct(product);
  displayProducts(currentFilteredProducts);
});

/* Remove product directly from selected products list */
selectedProductsList.addEventListener("click", (e) => {
  const removeButton = e.target.closest("[data-remove-id]");

  if (!removeButton) {
    return;
  }

  const productId = removeButton.dataset.removeId;
  selectedProducts = selectedProducts.filter(
    (product) => getProductId(product) !== productId
  );

  renderSelectedProducts();
  saveSelectedProducts();
  displayProducts(currentFilteredProducts);
});

/* Clear all saved selections */
clearSelectedProductsButton.addEventListener("click", () => {
  selectedProducts = [];
  renderSelectedProducts();
  saveSelectedProducts();
  displayProducts(currentFilteredProducts);
});

/* Reveal all products in the current filter */
showMoreProductsButton.addEventListener("click", () => {
  visibleProductsCount = currentFilteredProducts.length;
  displayProducts(currentFilteredProducts);
});

/* Generate routine from selected products */
generateRoutineButton.addEventListener("click", async () => {
  if (selectedProducts.length === 0) {
    chatWindow.textContent = "Select at least one product, then click Generate Routine.";
    return;
  }

  generateRoutineButton.disabled = true;
  chatWindow.textContent = "Generating your personalized routine...";

  try {
    const routineResponse = await generateRoutineFromProducts(selectedProducts);
    const routine = routineResponse.content;
    const selectedProductsJson = JSON.stringify(
      getProductsForPrompt(selectedProducts),
      null,
      2
    );

    lastGeneratedRoutine = routine;
    chatHistory = [
      {
        role: "system",
        content:
          "You are a beauty advisor. Answer ONLY questions about the generated routine or related beauty topics (skincare, haircare, makeup, fragrance). If user asks unrelated topics, politely refuse and redirect to beauty/routine guidance.",
      },
      {
        role: "user",
        content: `These are the selected products:\n\n${selectedProductsJson}\n\nPlease use this routine as context for follow-up Q&A.`,
      },
      {
        role: "assistant",
        content: routine,
      },
    ];

    chatWindow.innerHTML = "";
    appendChatMessage(
      "assistant",
      `Routine generated from ${selectedProducts.length} selected product(s):\n\n${routine}`,
      routineResponse.citations
    );
  } catch (error) {
    chatWindow.textContent = `Could not generate routine: ${error.message}`;
  } finally {
    generateRoutineButton.disabled = false;
  }
});

/* Show empty state in selected section on first load */
selectedProducts = loadSelectedProducts();
renderSelectedProducts();
initializeProducts();

/* Chat form submission handler - placeholder for OpenAI integration */
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const message = userInput.value.trim();

  if (!message) {
    return;
  }

  appendChatMessage("user", message);
  userInput.value = "";

  if (!lastGeneratedRoutine) {
    appendChatMessage(
      "assistant",
      "Please generate a routine first, then I can answer follow-up questions."
    );
    return;
  }

  chatHistory.push({ role: "user", content: message });

  try {
    const answerResponse = await getFollowUpResponse(message);
    appendChatMessage("assistant", answerResponse.content, answerResponse.citations);
    chatHistory.push({ role: "assistant", content: answerResponse.content });
  } catch (error) {
    appendChatMessage("assistant", `Could not answer follow-up question: ${error.message}`);
  }
});

/* Restore and apply saved direction on first load */
setDirection(loadSavedDirection());
