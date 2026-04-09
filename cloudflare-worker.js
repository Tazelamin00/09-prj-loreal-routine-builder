export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    try {
      const body = await request.json();
      const {
        messages,
        model = "gpt-4o",
        temperature = 0.7,
        useWebSearch = false,
      } = body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return jsonResponse({ error: "messages array is required" }, 400);
      }

      if (useWebSearch) {
        return handleWebSearchRequest(messages, temperature, env);
      }

      const openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
        }),
      });

      const data = await openAIResponse.json();

      if (!openAIResponse.ok) {
        const message = data?.error?.message || "OpenAI request failed";
        return jsonResponse({ error: message }, openAIResponse.status);
      }

      return jsonResponse(data, 200);
    } catch (error) {
      return jsonResponse({ error: error.message || "Unexpected worker error" }, 500);
    }
  },
};

async function handleWebSearchRequest(messages, temperature, env) {
  const responsesApiPayload = {
    model: "gpt-4.1-mini",
    tools: [{ type: "web_search_preview" }],
    input: messages,
    temperature,
  };

  const responsesApi = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(responsesApiPayload),
  });

  const responsesData = await responsesApi.json();

  if (!responsesApi.ok) {
    const message = responsesData?.error?.message || "OpenAI web search request failed";
    return jsonResponse({ error: message }, responsesApi.status);
  }

  const responseText = extractResponseText(responsesData);

  if (!responseText) {
    return jsonResponse({ error: "No web search response content returned" }, 502);
  }

  return jsonResponse(
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: responseText,
          },
        },
      ],
      citations: extractCitations(responsesData),
    },
    200
  );
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text) {
    return data.output_text;
  }

  if (!Array.isArray(data.output)) {
    return "";
  }

  const textParts = [];

  data.output.forEach((outputItem) => {
    if (!Array.isArray(outputItem.content)) {
      return;
    }

    outputItem.content.forEach((contentItem) => {
      if (contentItem.type === "output_text" && typeof contentItem.text === "string") {
        textParts.push(contentItem.text);
      }
    });
  });

  return textParts.join("\n\n").trim();
}

function extractCitations(data) {
  if (!Array.isArray(data.output)) {
    return [];
  }

  const citations = [];
  const seenUrls = new Set();

  data.output.forEach((outputItem) => {
    if (!Array.isArray(outputItem.content)) {
      return;
    }

    outputItem.content.forEach((contentItem) => {
      if (!Array.isArray(contentItem.annotations)) {
        return;
      }

      contentItem.annotations.forEach((annotation) => {
        const url = annotation?.url_citation?.url || annotation?.url;

        if (!url || seenUrls.has(url)) {
          return;
        }

        seenUrls.add(url);
        citations.push({
          title:
            annotation?.url_citation?.title ||
            annotation?.title ||
            "Source",
          url,
        });
      });
    });
  });

  return citations;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}
