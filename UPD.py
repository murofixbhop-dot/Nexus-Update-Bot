import discord
from discord.ext import commands
import os
import time
from flask import Flask, request, jsonify
from threading import Thread

# --- МИНИ-СЕРВЕР ДЛЯ ПРИЕМА WEBHOOK ОТ GITHUB ---
app = Flask('')

@app.route('/')
def home(): 
    return "Beauty Update Bot is Online!"

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    if data and 'commits' in data:
        raw_repo_name = data.get('repository', {}).get('name', '')
        display_name = REPO_NAMES.get(raw_repo_name, raw_repo_name)
        
        last_commit = data['commits'][0]
        message = last_commit.get('message', 'No description')
        author = last_commit.get('author', {}).get('name', 'Developer')
        
        bot.loop.create_task(send_beauty_update(display_name, message, author))
        return jsonify({"status": "success"}), 200
    return jsonify({"status": "ignored"}), 400

def run(): 
    # Запускаем сервер на порту 10000
    app.run(host='0.0.0.0', port=10000)

# --- НАСТРОЙКИ ---
TOKEN = os.getenv('DISCORDTOKEN') 
CHANNEL_ID = 1461974088334446704 

# СЛОВАРИК: "имя-репозитория-на-гитхабе": "Красивое Имя"
REPO_NAMES = {
    "Nexus-Hub-Not-Realese-": "🌊 Blox Fruits (Sea 1)",
    "Nexus-Hub-2-SEA": "🎣 Blox Fruits (Sea 2)",
    "Nexus-Beta-TSB": "✨ TSB (BETA)"
}

intents = discord.Intents.default()
intents.message_content = True 
bot = commands.Bot(command_prefix="?", intents=intents)

async def send_beauty_update(project_name, commit_text, author):
    channel = bot.get_channel(CHANNEL_ID)
    if not channel: return

    # --- ЛОГИКА РАЗДЕЛЕНИЯ ТЕКСТА ---
    lines = commit_text.split('\n')
    
    # 1. Первая строка — это версия
    version_label = lines[0] if lines else "Alpha v1"
    
    # 2. Остальные строки — это логи
    log_lines = lines[1:] if len(lines) > 1 else ["Update applied"]
    
    formatted_lines = []
    for line in log_lines:
        if not line.strip(): continue
        low = line.lower()
        if "added" in low: emoji = "🟢"
        elif "fix" in low: emoji = "🔵"
        elif "delete" in low or "remove" in low: emoji = "🔴"
        else: emoji = "✨"
        formatted_lines.append(f"{emoji} {line.strip()}")
            
    final_log = "\n".join(formatted_lines)

    # --- СОЗДАНИЕ КРАСИВОГО СООБЩЕНИЯ ---
    embed = discord.Embed(title="🚀 Nexus Hub : Script Update", color=0x00FFFF)
    
    embed.add_field(name="📌 Project", value=f"```{project_name}```", inline=True)
    embed.add_field(name="👤 Developer", value=f"```{author}```", inline=True)
    embed.add_field(name="✅ Status", value="```Working```", inline=True)
    
    # Твоё новое поле с версией
    embed.add_field(name="🆙 Version", value=f"```{version_label}```", inline=False)
    
    # Поле с логами и кружочками
    embed.add_field(name="📑 Change Logs", value=final_log, inline=False)
    
    embed.add_field(name="🔥 Note", value="Re-execute the script to apply changes!", inline=False)
    embed.set_footer(text=f"Nexus Intelligence | {time.strftime('%d.%m.%Y')}")
    
    await channel.send(content="@everyone", embed=embed)

@bot.event
async def on_ready():
    print(f'✅ Бот запущен и готов: {bot.user}')

@bot.command()
async def test(ctx):
    # Тест: первая строка версия, остальные с новой строки - логи
    msg = "Alpha v2.0\nAdded auto farm\nFix crash\nDelete old UI"
    await send_beauty_update("🌊 Blox Fruits Premium Hub", msg, ctx.author.name)

if __name__ == "__main__":
    # Запускаем Flask в отдельном потоке, чтобы он не вешал бота
    Thread(target=run).start()

    bot.run(TOKEN)
