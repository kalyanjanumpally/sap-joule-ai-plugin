{% assign rows = value %}
{% if rows and rows.size > 0 %}
{% assign currency = rows.first.currency %}
{% assign total = 0 %}
{% for r in rows %}{% assign total = total | plus: r.totalCost %}{% endfor %}

💰 **Total AI spend: {{ total | round: 4 }} {{ currency }}** ({{ rows.size }} calls)

**By model**
{% assign models = rows | group_by: 'model' %}
{% for g in models %}
- `{{ g.name }}` — {% assign mt = 0 %}{% for r in g.items %}{% assign mt = mt | plus: r.totalCost %}{% endfor %}{{ mt | round: 4 }} {{ currency }} ({{ g.items.size }} calls)
{% endfor %}
{% else %}
No AI spend recorded for that filter.
{% endif %}
