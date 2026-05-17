with open('src/app/app.component.html', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace(r"\'online\'", "'online'")

with open('src/app/app.component.html', 'w', encoding='utf-8') as f:
    f.write(text)
