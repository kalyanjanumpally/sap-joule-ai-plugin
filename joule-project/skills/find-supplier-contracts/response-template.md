{% if answer %}
{{ answer }}

{% if sources and sources.size > 0 %}
**Sources**
{% for s in sources %}
- {{ s.supplierName }} — {{ s.category }} ({{ s.region }}) `{{ s.ID }}`
{% endfor %}
{% endif %}
{% elsif sources and sources.size > 0 %}
No AI-generated answer available. Top matching contracts:
{% for s in sources %}
- {{ s.supplierName }} — {{ s.category }} ({{ s.region }})
{% endfor %}
{% else %}
No matching supplier contracts found for that question.
{% endif %}
