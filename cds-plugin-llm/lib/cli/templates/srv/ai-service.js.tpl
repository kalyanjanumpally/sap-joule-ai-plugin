const cds = require('@sap/cds');

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

    return super.init();
  }
};
