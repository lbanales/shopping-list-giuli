exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      ok: true,
      eco: (event.queryStringParameters || {}).eco || null,
      hora: new Date().toISOString(),
      agente: event.headers["user-agent"] || null
    })
  };
};
