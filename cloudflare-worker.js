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
      const { messages, model = "gpt-4o", temperature = 0.7 } = body;

      if (!Array.isArray(messages) || messages.length === 0) {
        return jsonResponse({ error: "messages array is required" }, 400);
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
