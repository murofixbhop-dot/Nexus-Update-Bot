import discord
from discord.ext import tasks, commands
from discord.ui import Button, View
import requests
import json
import os
import time
from flask import Flask, request, jsonify
from threading import Thread

# --- НАСТРОЙКИ (ПРОВЕРЬ ID КАНАЛОВ!) ---
TOKEN = os.getenv('DISCORDTOKEN') 
UPDATE_CHANNEL_ID = 1461974088334446704 
ROBLOX_CHANNEL_ID = 1467906321490641109 
EXPLOIT_CHANNEL_ID = 1471880566306504754 # Канал для статусов инжекторов
DATA_FILE = 'data.json'

# Список исключений для мониторинга
EXCLUDE_LIST = ["RbxCli", "macexploit", "Severe", "Matcha", "Hydrogen", "DX9WARE V2", "Serotonin"]

# Названия проектов для красивых карточек
REPO_CONFIG = {
    "Nexus-Beta-TSB": {"name": "✨ TSB (BETA)", "color": 0x00FFFF},
    "Nexus-Hub-2-SEA": {"name": "🎣 Blox Fruits (Sea 2)", "color": 0xFFA500},
    "Nexus-Hub-Not-Realese-": {"name": "🌊 Blox Fruits (Sea 1)", "color": 0x0000FF},
    "default": {"name": "Nexus Project", "color": 0xcccccc}
}

# --- МИНИ-СЕРВЕР ДЛЯ RENDER И WEBHOOK ---
app = Flask('')

@app.route('/')
def home():
    return "Nexus Core System is Online!"

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    if data and 'commits' in data:
        repo_name = data.get('repository', {}).get('name', '')
        info = REPO_CONFIG.get(repo_name, REPO_CONFIG["default"])
        last_commit = data['commits'][0]
        message = last_commit.get('message', 'No description')
        author = last_commit.get('author', {}).get('name', 'Developer')
        bot.loop.create_task(send_github_update(info, message, author))
        return jsonify({"status": "success"}), 200
    return jsonify({"status": "ignored"}), 400

def run_flask():
    app.run(host='0.0.0.0', port=10000)

# --- ЛОГИКА ДАННЫХ ROBLOX ---
def load_data():
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r') as f:
                content = json.load(f)
                if "history" not in content: content["history"] = []
                if "exploit_msg_id" not in content: content["exploit_msg_id"] = None
                return content
        except: pass
    return {"live": None, "future": None, "last_msg_id": None, "history": [], "exploit_msg_id": None}

def save_data(live, future, msg_id, history, exploit_msg_id):
    with open(DATA_FILE, 'w') as f:
        json.dump({
            "live": live, 
            "future": future, 
            "last_msg_id": msg_id, 
            "history": history, 
            "exploit_msg_id": exploit_msg_id
        }, f)

current_data = load_data()
last_versions = {"live": current_data.get("live"), "future": current_data.get("future")}
last_msg_id = [current_data.get("last_msg_id")]
version_history = current_data.get("history", [])
exploit_msg_id = [current_data.get("exploit_msg_id")]

# --- КЛАСС КНОПКИ ИСТОРИИ ---
class HistoryView(View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Show History", style=discord.ButtonStyle.secondary, custom_id="btn_history")
    async def show_history(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not version_history:
            return await interaction.response.send_message("History is empty.", ephemeral=True)
        h_list = "**Last 10 recorded versions:**\n\n"
        for v in version_history[-10:]:
            link = f"https://rdd.whatexpsare.online/?channel=LIVE&binaryType=WindowsPlayer&version={v}"
            h_list += f"• `{v}` — [Download]({link})\n"
        await interaction.response.send_message(h_list, ephemeral=True)

# --- ИНИЦИАЛИЗАЦИЯ БОТА ---
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

# --- КОМАНДЫ ---
@bot.command()
async def version(ctx):
    """Принудительное обновление статуса Roblox"""
    try:
        await ctx.message.delete()
    except: pass
    
    live = get_roblox_v("live")
    future = get_roblox_v("znext")
    if live:
        await update_roblox_msg(ctx.channel, live, future or live)

@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.CommandNotFound):
        return 
    print(f"❌ Ошибка команды: {error}")

# --- ОТПРАВКА ОБНОВЛЕНИЙ GITHUB (ПОЛНАЯ ВЕРСИЯ С ЭМОДЗИ) ---
async def send_github_update(info, commit_text, author):
    channel = bot.get_channel(UPDATE_CHANNEL_ID)
    if not channel: return
    
    lines = commit_text.split('\n')
    version_label = lines[0] if lines else "Alpha v1"
    
    formatted_logs = []
    for line in lines[1:]:
        if not line.strip(): continue
        low = line.lower()
        emoji = "🟢" if "add" in low else "🔵" if "fix" in low else "🔴" if "rem" in low or "del" in low else "✨"
        formatted_logs.append(f"{emoji} {line.strip()}")
            
    logs_text = "\n".join(formatted_logs) if formatted_logs else "Update applied"

    embed = discord.Embed(title=f"🚀 {info['name']} : Update", color=info["color"])
    embed.add_field(name="📌 Project", value=f"```{info['name']}```", inline=True)
    embed.add_field(name="👤 Developer", value=f"```{author}```", inline=True)
    embed.add_field(name="✅ Status", value="```Working```", inline=True)
    embed.add_field(name="🆙 Version", value=f"```{version_label}```", inline=False)
    embed.add_field(name="📑 Change Logs", value=logs_text, inline=False)
    embed.set_footer(text=f"Nexus Intel | {time.strftime('%d.%m.%Y')}")
    
    await channel.send(content="@everyone", embed=embed)

# --- МОНИТОРИНГ ИНЖЕКТОРОВ ---
@tasks.loop(minutes=2)
async def check_exploits():
    channel = bot.get_channel(EXPLOIT_CHANNEL_ID)
    if not channel: return

    headers = {'User-Agent': 'WEAO-3PService'}
    try:
        r = requests.get("https://weao.xyz/api/status/exploits", timeout=10, headers=headers)
        if r.status_code != 200: return
        data = r.json()
    except: return

    embed = discord.Embed(title="🛡️ Nexus Exploit Status", color=0x00FBFF)
    status_text = ""
    for entry in data:
        name = entry.get("title", "Unknown")
        if name in EXCLUDE_LIST: continue
        is_updated = entry.get("updateStatus", False)
        version = entry.get("version", "N/A")
        is_detected = entry.get("detected", False)
        emoji = "🟢" if is_updated else "🔴"
        detect_warn = "⚠️" if is_detected else ""
        status_text += f"{emoji} **{name}**: `{'Working' if is_updated else 'Patched'}` {detect_warn} | (v{version})\n"

    embed.description = status_text if status_text else "No data available."
    embed.set_footer(text=f"Sync: {time.strftime('%H:%M:%S')} | Powered by WEAO")

    # Умный поиск сообщения для редактирования
    if not exploit_msg_id[0]:
        async for message in channel.history(limit=10):
            if message.author == bot.user and message.embeds and "🛡️ Nexus Exploit Status" in str(message.embeds[0].title):
                exploit_msg_id[0] = message.id
                break

    if exploit_msg_id[0]:
        try:
            msg = await channel.fetch_message(exploit_msg_id[0])
            await msg.edit(embed=embed)
        except:
            msg = await channel.send(embed=embed)
            exploit_msg_id[0] = msg.id
    else:
        msg = await channel.send(embed=embed)
        exploit_msg_id[0] = msg.id
    
    save_data(last_versions["live"], last_versions["future"], last_msg_id[0], version_history, exploit_msg_id[0])

# --- ТРЕКЕР ROBLOX ---
def get_roblox_v(channel="live"):
    url = f"https://clientsettings.roblox.com/v2/client-version/WindowsPlayer{'' if channel=='live' else '/channel/znext'}?t={int(time.time())}"
    try:
        r = requests.get(url, timeout=10, headers={'User-Agent': 'Mozilla/5.0'})
        return r.json().get("clientVersionUpload") if r.status_code == 200 else None
    except: return None

async def update_roblox_msg(channel, live, future, is_update=False):
    if live and live not in version_history:
        version_history.append(live)
        if len(version_history) > 20: version_history.pop(0)
    
    # Умный поиск старой карточки Roblox
    if not last_msg_id[0]:
        async for message in channel.history(limit=10):
            if message.author == bot.user and message.embeds and ("Roblox Status" in str(message.embeds[0].title) or "Roblox Update Detected!" in str(message.embeds[0].title)):
                last_msg_id[0] = message.id
                break

    is_future = live != future
    embed = discord.Embed(title="Roblox Update Detected!" if is_future else "Roblox Status", color=0xFFCC00 if is_future else 0x2ecc71)
    embed.add_field(name="Current Live Hash:", value=f"`{live}`\n[Download]({f'https://rdd.whatexpsare.online/?channel=LIVE&binaryType=WindowsPlayer&version={live}'})", inline=False)
    if is_future:
        embed.add_field(name="Future Hash (ZNEXT):", value=f"`{future}`", inline=False)
    embed.set_footer(text=f"Nexus Tracker | {time.strftime('%H:%M')}")
    
    if last_msg_id[0]:
        try:
            msg = await channel.fetch_message(last_msg_id[0])
            # Редактируем старое, чтобы не плодить сообщения
            await msg.edit(content="@everyone" if is_update else "", embed=embed, view=HistoryView())
        except:
            msg = await channel.send(content="@everyone" if is_update else "", embed=embed, view=HistoryView())
            last_msg_id[0] = msg.id
    else:
        msg = await channel.send(content="@everyone" if is_update else "", embed=embed, view=HistoryView())
        last_msg_id[0] = msg.id
    
    save_data(live, future, last_msg_id[0], version_history, exploit_msg_id[0])

@tasks.loop(minutes=1)
async def check_roblox():
    live, future = get_roblox_v("live"), get_roblox_v("znext")
    if not live or not future: return
    if live != last_versions["live"] or future != last_versions["future"]:
        channel = bot.get_channel(ROBLOX_CHANNEL_ID)
        if channel:
            last_versions["live"], last_versions["future"] = live, future
            await update_roblox_msg(channel, live, future, is_update=True)

@bot.event
async def on_ready():
    print(f'✅ Nexus Core запущен: {bot.user}')
    bot.add_view(HistoryView())
    if not check_roblox.is_running(): 
        check_roblox.start()
    if not check_exploits.is_running():
        check_exploits.start()

if __name__ == "__main__":
    Thread(target=run_flask).start()
    bot.run(TOKEN)
