{% if value and value.size > 0 %}
{% assign r = value.first %}
Found `{{ identifier }}` — **{{ r.supplierName }}** ({{ r.contractType }}, {{ r.region }})

- Supplier: {{ r.supplierName }}
- Contract type: {{ r.contractType }}
- Category: {{ r.category }}
- Region: {{ r.region }}
- Entity ID: `{{ r.ID }}`
{% else %}
No contract found for `{{ identifier }}`.
{% endif %}
