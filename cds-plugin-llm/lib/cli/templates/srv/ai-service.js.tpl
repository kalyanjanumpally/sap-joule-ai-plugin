const cds = require('@sap/cds');
const express = require('express');

module.exports = class AIService extends cds.ApplicationService {
  async init() {
    const llm = await cds.connect.to('llm');

    this.on('chat', async (req) => {
      const { prompt } = req.data;
      const res = await llm.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
      });
      return res.text;
    });

    this.on('summarize', async (req) => {
      const { text } = req.data;
      const res = await llm.chat({
        system: 'You are a concise summarizer. Reply in 2-3 sentences.',
        messages: [{ role: 'user', content: text }],
        maxTokens: 512,
      });
      return res.text;
    });

    // Custom SSE streaming endpoint at /stream/chat — registered on the
    // outer Express app, OUTSIDE the OData mount. Body: { prompt, system? }.
    // Sends `data: <json>\n\n` frames for each token; `data: [DONE]\n\n`
    // when finished.
    cds.app.post('/stream/chat', express.json({ limit: '1mb' }), async (req, res) => {
      const { prompt, system } = req.body ?? {};
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      try {
        const chatReq = { messages: [{ role: 'user', content: prompt }], maxTokens: 1024 };
        if (system) chatReq.system = system;
        for await (const chunk of llm.stream(chatReq)) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
    });

    return super.init();
  }
};
