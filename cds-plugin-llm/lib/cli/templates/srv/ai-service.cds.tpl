service AIService @(path: '/ai') {
  function chat(prompt: String) returns String;
  function summarize(text: String) returns String;
}
