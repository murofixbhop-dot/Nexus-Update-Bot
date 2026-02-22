import discord
from discord.ext import tasks, commands
from discord.ui import Button, View, Select
import requests
import json
import os
import time
import google.generativeai as genai
from flask import Flask, request, jsonify
from threading import Thread

# --- НАСТРОЙКИ (ID КАНАЛОВ И РОЛЕЙ) ---
TOKEN = os.getenv('DISCORDTOKEN') 
UPDATE_CHANNEL_ID = 1461974088334446704 
ROBLOX_CHANNEL_ID = 1467906321490641109 
EXPLOIT_CHANNEL_ID = 1471880566306504754
ROLE_CHANNEL_ID = 1472109649053356139  
AI_CHANNEL_ID = 1475235177818230964   
DATA_FILE = 'data.json'

# Ссылка на твой Вебхук и картинку
AI_WEBHOOK_URL = "https://discord.com/api/webhooks/1475241998192738465/3oizxu-P-te46UHTQYspsI056qAUnT9TwwM8YDLeiJTQIx1VmoTdhdaZtiiNb4bMwjmO"
AI_AVATAR_URL = "https://i.ibb.co/C3m2BskD/Nexus-AI-Icon.png" 

# Твои ID Ролей
ROLE_SCRIPT_ID = 1472108709059625034
ROLE_EXECUTER_ID = 1472108653552337049
ROLE_ROBLOX_ID = 1472108155138867251
OWNER_ROLE_ID = 1467919040671387872 # Роль для смены моделей

# --- НАСТРОЙКА ИИ ---
RAW_AI_KEY = os.getenv('GEMMA_KEY')
if RAW_AI_KEY:
    AI_KEY = RAW_AI_KEY.strip().replace('"', '').replace("'", "")
    genai.configure(api_key=AI_KEY)
else:
    AI_KEY = None

generation_config = {
  "temperature": 0.8,
  "top_p": 0.95,
  "top_k": 40,
  "max_output_tokens": 4096,
}

SYSTEM_PROMPT = "Ты — Nexus AI. Ты очень дружелюбный и любишь использовать смайлики 😊. Ты эксперт в программировании и можешь написать любой код (Lua, Python, JS и т.д.), который попросит пользователь. Если в твоем ответе есть код, обязательно выделяй его в блоки кода с окантовкой: ```язык\nкод\n```."

# Глобальная переменная для текущей модели
CURRENT_AI_MODEL = "gemma-3-27b"

# Список исключений для мониторинга
EXCLUDE_LIST = ["RbxCli", "macexploit", "Severe", "Matcha", "Hydrogen", "DX9WARE V2", "Serotonin"]

# Названия проектов для красивых карточек GitHub
REPO_CONFIG = {
    "Nexus-Beta-TSB": {"name": "✨ TSB (BETA)", "color": 0x00FFFF},
    "Nexus-Hub-2-SEA": {"name": "🎣 Blox Fruits (Sea 2)", "color": 0xFFA500},
    "Nexus-Hub-Not-Realese-": {"name": "🌊 Blox Fruits (Sea 1)", "color": 0x0000FF},
    "default": {"name": "Nexus Project", "color": 0xcccccc}
}

# --- МИНИ-СЕРВЕР ДЛЯ RENDER ---
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

# --- ЛОГИКА ДАННЫХ (ROBLOX & EXPLOITS) ---
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

# --- МЕНЮ ВЫБОРА МОДЕЛЕЙ (DROPDOWN) ---
class ModelSelect(discord.ui.Select):
    def __init__(self):
        options = [
            discord.SelectOption(label="Gemma 3 27B", value="gemma-3-27b", emoji="🧠", description="Тяжелая и мощная (Other models)"),
            discord.SelectOption(label="Gemma 3 12B", value="gemma-3-12b", emoji="🤖", description="Баланс скорости и качества"),
            discord.SelectOption(label="Gemini 3 Flash", value="gemini-3-flash", emoji="⚡", description="Мощная новинка"),
            discord.SelectOption(label="Gemini 2.5 Flash", value="gemini-2.5-flash", emoji="🔥", description="Супер быстрая"),
            discord.SelectOption(label="Gemma 3 4B", value="gemma-3-4b", emoji="📱", description="Легкая"),
            discord.SelectOption(label="Gemma 3 2B", value="gemma-3-2b", emoji="🔋", description="Ультра легкая")
        ]
        super().__init__(placeholder="Выберите активную модель ИИ...", min_values=1, max_values=1, options=options)

    async def callback(self, interaction: discord.Interaction):
        global CURRENT_AI_MODEL
        # Дополнительная проверка на права
        if not any(role.id == OWNER_ROLE_ID for role in interaction.user.roles):
            return await interaction.response.send_message("❌ У вас нет прав изменять модель!", ephemeral=True)
        
        CURRENT_AI_MODEL = self.values[0]
        await interaction.response.send_message(f"✅ Модель успешно изменена на **{CURRENT_AI_MODEL}**! Все новые запросы пойдут через неё.", ephemeral=True)

class ModelSelectView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=30) # Вьюха перестанет работать через 30 секунд
        self.add_item(ModelSelect())

# --- ВЬЮ КНОПОК ИСТОРИИ И РОЛЕЙ ---
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

class RoleView(View):
    def __init__(self):
        super().__init__(timeout=None)

    async def toggle_role(self, interaction: discord.Interaction, role_id: int):
        role = interaction.guild.get_role(role_id)
        if not role:
            return await interaction.response.send_message("Роль не найдена!", ephemeral=True)
        
        if role in interaction.user.roles:
            await interaction.user.remove_roles(role)
            await interaction.response.send_message(f"❌ Роль **{role.name}** убрана.", ephemeral=True)
        else:
            await interaction.user.add_roles(role)
            await interaction.response.send_message(f"✅ Роль **{role.name}** выдана!", ephemeral=True)

    @discord.ui.button(label="Executer UPD", style=discord.ButtonStyle.primary, custom_id="role_exec")
    async def exec_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.toggle_role(interaction, ROLE_EXECUTER_ID)

    @discord.ui.button(label="Roblox UPD", style=discord.ButtonStyle.success, custom_id="role_roblox")
    async def roblox_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.toggle_role(interaction, ROLE_ROBLOX_ID)

    @discord.ui.button(label="Script UPD", style=discord.ButtonStyle.danger, custom_id="role_script")
    async def script_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.toggle_role(interaction, ROLE_SCRIPT_ID)

# --- ИНИЦИАЛИЗАЦИЯ БОТА ---
intents = discord.Intents.all()
bot = commands.Bot(command_prefix="!", intents=intents)

# --- ФУНКЦИЯ ОТПРАВКИ ЧЕРЕЗ ВЕБХУК ---
def send_to_webhook(content, username, avatar_url):
    data = {
        "content": content,
        "username": username,
        "avatar_url": avatar_url
    }
    requests.post(AI_WEBHOOK_URL, json=data)

# --- ОБРАБОТКА ИИ ЧЕРЕЗ ВЕБХУК ---
@bot.event
async def on_message(message):
    if message.author == bot.user: return
    
    content = message.content.lower()
    
    if message.channel.id == AI_CHANNEL_ID:
        ai_variants = ('?ai', '?аи')
        limit_variants = ('?limit', '?лимит', '?LIMIT')
        models_variants = ('?models', '?model', '?модели')
        setmodel_variants = ('?setmodels', '?setmodel', '?setmodel')
        
        # 1. КОМАНДА ВЫБОРА МОДЕЛЕЙ (ТОЛЬКО ДЛЯ ВЛАДЕЛЬЦА)
        if content.startswith(setmodel_variants):
            try: await message.delete()
            except: pass
            
            # Проверка наличия роли Owner
            has_owner_role = any(role.id == OWNER_ROLE_ID for role in message.author.roles)
            if not has_owner_role:
                return # Если роли нет, просто игнорируем
            
            embed = discord.Embed(title="⚙️ Панель управления моделями ИИ", description="Выберите модель из выпадающего списка ниже. Окно исчезнет через 30 секунд.", color=0x2ecc71)
            embed.set_footer(text=f"Текущая модель: {CURRENT_AI_MODEL}")
            
            view = ModelSelectView()
            await message.channel.send(content=message.author.mention, embed=embed, view=view, delete_after=30)
            return

        # 2. ОСНОВНАЯ КОМАНДА ИИ
        if content.startswith(ai_variants):
            prompt = message.content[3:].strip()
            if not prompt: return
            
            try: await message.delete()
            except: pass

            async with message.channel.typing():
                try:
                    # Динамически создаем модель перед запросом
                    current_model = genai.GenerativeModel(
                        model_name=CURRENT_AI_MODEL,
                        generation_config=generation_config,
                        system_instruction=SYSTEM_PROMPT
                    )
                    
                    response = current_model.generate_content(prompt)
                    full_answer = f"**Ответ для {message.author.mention}:**\n{response.text}"
                    
                    # Отправляем через вебхук
                    send_to_webhook(full_answer, "Nexus AI", AI_AVATAR_URL)
                    
                except Exception as e:
                    # Если ошибка — пишем её в канал обычным сообщением, чтобы ты мог увидеть лог (например 404)
                    await message.channel.send(f"❌ Ошибка Nexus AI (Модель: `{CURRENT_AI_MODEL}`): {e}", delete_after=15)
            return

        # 3. ПОКАЗАТЬ ДОСТУПНЫЕ МОДЕЛИ (ДЛЯ ВСЕХ, НА 30 СЕК)
        if content.startswith(models_variants):
            try: await message.delete()
            except: pass
            embed = discord.Embed(title="🤖 Доступные модели Nexus AI", color=0x3498db)
            embed.description = (
                f"**Текущая активная модель:** `{CURRENT_AI_MODEL}`\n\n"
                "**Список поддерживаемых из таблицы:**\n"
                "• `gemma-3-27b` — Тяжелая модель\n"
                "• `gemma-3-12b`\n"
                "• `gemma-3-4b`\n"
                "• `gemma-3-2b`\n"
                "• `gemini-3-flash` — Очень быстрая\n"
                "• `gemini-2.5-flash`\n"
                "• `gemini-2.5-flash-native-audio-dialog`\n\n"
                "*Сменить модель может только участник с ролью Owner.*"
            )
            await message.channel.send(content=f"{message.author.mention}", embed=embed, delete_after=30)
            return

        # 4. ЛИМИТЫ (ДЛЯ ВСЕХ, НА 30 СЕК)
        if content.startswith(limit_variants):
            try: await message.delete()
            except: pass
            embed = discord.Embed(title="📊 Nexus AI Limits", color=0x9b59b6)
            embed.description = f"• Active Model: **{CURRENT_AI_MODEL}**\n• Status: 🟢 Online\n• Requests: Unlimited API Tier\n• Context: Variable (up to 1M)"
            await message.channel.send(content=f"{message.author.mention}", embed=embed, delete_after=30)
            return

    await bot.process_commands(message)

# --- КОМАНДЫ ---
@bot.command()
@commands.has_permissions(administrator=True)
async def init_roles(ctx):
    if ctx.channel.id != ROLE_CHANNEL_ID:
        return await ctx.send(f"Эту команду можно использовать только в <#{ROLE_CHANNEL_ID}>")
    
    embed = discord.Embed(
        title="🔔 Nexus Core | Notifications",
        description=(
            "Выберите роли, чтобы получать уведомления:\n\n"
            "🔹 **Executer UPD** — Статусы читов\n"
            "🟢 **Roblox UPD** — Обновления Roblox\n"
            "🔴 **Script UPD** — Обновления скриптов (GitHub)"
        ),
        color=0x2b2d31
    )
    await ctx.send(embed=embed, view=RoleView())
    await ctx.message.delete()

@bot.command()
async def version(ctx):
    try: await ctx.message.delete()
    except: pass
    live = get_roblox_v("live")
    if live: await update_roblox_msg(ctx.channel, live, live)

# --- ОСНОВНЫЕ ФУНКЦИИ ---
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
    
    await channel.send(content=f"<@&{ROLE_SCRIPT_ID}>", embed=embed)

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
    
    if not last_msg_id[0]:
        async for m in channel.history(limit=10):
            if m.author == bot.user and m.embeds and "Roblox" in str(m.embeds[0].title):
                last_msg_id[0] = m.id; break

    embed = discord.Embed(title="Roblox Status", color=0x2ecc71)
    embed.add_field(name="Current Live Hash:", value=f"`{live}`\n[Download]({f'https://rdd.whatexpsare.online/?channel=LIVE&binaryType=WindowsPlayer&version={live}'})", inline=False)
    embed.set_footer(text=f"Nexus Tracker | {time.strftime('%H:%M')}")
    
    content = f"<@&{ROLE_ROBLOX_ID}>" if is_update else ""
    
    if last_msg_id[0]:
        try:
            msg = await channel.fetch_message(last_msg_id[0])
            await msg.edit(content=content, embed=embed, view=HistoryView())
        except:
            msg = await channel.send(content=content, embed=embed, view=HistoryView())
            last_msg_id[0] = msg.id
    else:
        msg = await channel.send(content=content, embed=embed, view=HistoryView())
        last_msg_id[0] = msg.id
    
    save_data(live, future, last_msg_id[0], version_history, exploit_msg_id[0])

@tasks.loop(minutes=1)
async def check_roblox():
    live, future = get_roblox_v("live"), get_roblox_v("znext")
    if live and (live != last_versions["live"] or future != last_versions["future"]):
        channel = bot.get_channel(ROBLOX_CHANNEL_ID)
        if channel:
            last_versions["live"], last_versions["future"] = live, future
            await update_roblox_msg(channel, live, future, is_update=True)

@bot.event
async def on_ready():
    print(f'✅ Nexus Core System Ready | User: {bot.user}')
    bot.add_view(HistoryView())
    bot.add_view(RoleView()) 
    if not check_roblox.is_running(): check_roblox.start()
    if not check_exploits.is_running(): check_exploits.start()

if __name__ == "__main__":
    Thread(target=run_flask).start()
    bot.run(TOKEN)
