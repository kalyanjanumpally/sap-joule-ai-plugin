{
  "name": "{{APP_NAME}}",
  "version": "0.1.0",
  "description": "SAP CAP app pre-wired to @saptarishi/cds-plugin-llm ({{PROVIDER_KIND}}).",
  "private": true,
  "scripts": {
    "start": "cds-serve",
    "watch": "cds watch"
  },
  "dependencies": {
    "@sap/cds": "^9.0.0",
    "@saptarishi/cds-plugin-llm": "^{{PLUGIN_VERSION}}"
  },
  "cds": {
    "requires": {
      "llm": {{LLM_CONFIG_JSON}}
    }
  }
}
