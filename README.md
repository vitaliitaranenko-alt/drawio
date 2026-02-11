# Draw.io MCP Server

Глобальний MCP сервер для роботи з Draw.io діаграмами в Kiro CLI.

## Встановлення

Сервер встановлено глобально в `~/.kiro-mcp-servers/drawio/`

## Використання в будь-якому проекті

1. Створіть `.drawio` або `.xml` файл з діаграмою
2. Збережіть його в проекті (наприклад, `docs/diagrams/`)
3. У Kiro CLI використовуйте команди:

```
Проаналізуй діаграму docs/diagrams/my-diagram.xml
Витягни класи з діаграми architecture.drawio.xml
Порівняй діаграму з кодом
Згенеруй тести на основі схеми
```

## Доступні інструменти

### parse_drawio
Парсить Draw.io файл та витягує всі компоненти

### extract_classes
Витягує класи, методи та поля з діаграми класів

### extract_relationships
Витягує зв'язки між компонентами (наслідування, композиція, асоціація)

## Конфігурація

Конфігурація: `~/.config/kiro-cli/mcp-config.json`

```json
{
  "mcpServers": {
    "drawio": {
      "command": "node",
      "args": ["~/.kiro-mcp-servers/drawio/index.js"],
      "env": {}
    }
  }
}
```

## Підтримувані формати

- `.drawio` - нативний формат Draw.io
- `.xml` - XML експорт з Draw.io
- `.drawio.xml` - Draw.io XML

## Приклади використання

**Аналіз архітектури:**
```
Проаналізуй architecture.drawio та покажи всі компоненти
```

**Порівняння з кодом:**
```
Порівняй class-diagram.xml з Java класами в src/main/java
```

**Генерація тестів:**
```
На основі sequence-diagram.drawio згенеруй інтеграційні тести
```

**Валідація:**
```
Перевір чи всі класи з діаграми реалізовані в коді
```

## Оновлення

Для оновлення сервера:
```bash
cd ~/.kiro-mcp-servers/drawio
npm update
```

## Видалення

```bash
rm -rf ~/.kiro-mcp-servers/drawio
# Видалити секцію "drawio" з ~/.config/kiro-cli/mcp-config.json
```
