import discord
from discord.ext import tasks, commands
from discord.ui import Button, View, Select
import requests
import json
import os
import time
import re
import google.generativeai as genai
from openai import OpenAI  # для Groq (OpenAI-совместимый)
from flask import Flask, request, jsonify
from threading import Thread
from pymongo import MongoClient

# --- НАСТРОЙКИ ---
TOKEN = os.getenv('DISCORDTOKEN')
UPDATE_CHANNEL_ID = 1461974088334446704
ROBLOX_CHANNEL_ID = 1467906321490641109
EXPLOIT_CHANNEL_ID = 1471880566306504754
ROLE_CHANNEL_ID = 1472109649053356139
AI_CHANNEL_ID = 1475235177818230964

AI_WEBHOOK_URL = "https://discord.com/api/webhooks/1475241998192738465/3oizxu-P-te46UHTQYspsI056qAUnT9TwwM8YDLeiJTQIx1VmoTdhdaZtiiNb4bMwjmO"
AI_AVATAR_URL = "https://i.ibb.co/C3m2BskD/Nexus-AI-Icon.png"

ROLE_SCRIPT_ID = 1472108709059625034
ROLE_EXECUTER_ID = 1472108653552337049
ROLE_ROBLOX_ID = 1472108155138867251
OWNER_ROLE_ID = 1467919040671387872

# --- MONGODB ---
MONGO_URI = os.getenv('MONGODB_URI')
mongo_client = MongoClient(MONGO_URI)
db = mongo_client["nexusbot"]
col_config = db["config"]
col_history = db["roblox_history"]
col_ai = db["ai_histories"]

def db_get(key, default=None):
    doc = col_config.find_one({"_id": key})
    return doc["value"] if doc else default

def db_set(key, value):
    col_config.update_one({"_id": key}, {"$set": {"value": value}}, upsert=True)

def get_version_history():
    doc = col_history.find_one({"_id": "history"})
    return doc["versions"] if doc else []

def save_version_history(versions):
    col_history.update_one({"_id": "history"}, {"$set": {"versions": versions}}, upsert=True)

def get_user_history(uid):
    doc = col_ai.find_one({"_id": str(uid)})
    return doc["history"] if doc else []

def save_user_history(uid, history):
    col_ai.update_one({"_id": str(uid)}, {"$set": {"history": history}}, upsert=True)

def delete_user_history(uid):
    col_ai.delete_one({"_id": str(uid)})

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

# --- GROQ CLIENT ---
GROQ_KEY = os.getenv('GROQ_KEY')
groq_client = OpenAI(
    api_key=GROQ_KEY,
    base_url="https://api.groq.com/openai/v1"
) if GROQ_KEY else None

GROQ_MODELS = {
    # Production
    "llama-3.3-70b-versatile", "llama-3.1-8b-instant",
    "openai/gpt-oss-120b", "openai/gpt-oss-20b",
    # Preview
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "deepseek-r1-distill-llama-70b",
    "qwen-qwq-32b",
    "qwen/qwen3-32b",
    "moonshotai/kimi-k2-instruct-0905",
    # Compound (web search)
    "groq/compound", "groq/compound-mini",
}

# Модели с реальным доступом в интернет (поиск встроен в API)
WEB_SEARCH_MODELS = {"groq/compound", "groq/compound-mini"}

_SYSTEM_BASE = (
    "Ты — Nexus AI. Отвечай максимально коротко — 1-2 предложения если вопрос простой. "
    "Никаких вступлений, не повторяй вопрос, без лишних слов. "
    "Смайлики только если очень уместно. "
    "Код пиши полностью, ничего не обрезай и не удаляй из предыдущего кода если не просили. "
    "Код оборачивай в блоки: ```язык\nкод\n```. "
)
# Для обычных моделей — без интернета
SYSTEM_PROMPT = _SYSTEM_BASE + (
    "У тебя нет доступа в интернет. Если просят что-то поискать — честно скажи об этом и ответь из своих знаний. "
    "Никогда не придумывай ссылки и не симулируй поиск."
)
# Для Compound — есть интернет
SYSTEM_PROMPT_WEB = _SYSTEM_BASE + (
    "У тебя ЕСТЬ доступ в интернет через встроенный поиск — используй его когда нужна актуальная информация. "
    "Никогда не придумывай ссылки — только реальные из поиска."
)

# Текущая модель хранится в MongoDB для синхронизации
def get_current_model():
    return db_get("current_model", "gemini-2.5-flash")

def set_current_model(model):
    db_set("current_model", model)

# Для удобства — инициализируем если не задана
if not db_get("current_model"):
    set_current_model("gemini-2.5-flash")

def get_auto_mode():
    return db_get("auto_mode", False)

def set_auto_mode(val: bool):
    db_set("auto_mode", val)

# Порядок перебора моделей в авто-режиме (от надёжных к запасным)
AUTO_FALLBACK_ORDER = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "gemini-2.0-flash",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "gemini-3-flash-preview",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "deepseek-r1-distill-llama-70b",
    "qwen/qwen3-32b",
    "qwen-qwq-32b",
    "moonshotai/kimi-k2-instruct-0905",
]
MAX_HISTORY = 30

# Информация о моделях: название, лимиты (requests/day, tokens/min)
MODELS_INFO = {
    # ===== GOOGLE GEMINI 3 (новейшие) =====
    "gemini-3.1-pro-preview": {
        "label": "Gemini 3.1 Pro Preview 🆕", "call": "gemini-3.1-pro-preview",
        "rpm": 5, "rpd": 25, "tpm": 64000,
        "desc": "Новейший, лучший reasoning 🏆", "provider": "Google"
    },
    "gemini-3-flash-preview": {
        "label": "Gemini 3 Flash Preview 🆕", "call": "gemini-3-flash-preview",
        "rpm": 10, "rpd": 100, "tpm": 250000,
        "desc": "Gemini 3 скорость + умность", "provider": "Google"
    },
    # ===== GOOGLE GEMINI 2.5 =====
    "gemini-2.5-flash": {
        "label": "Gemini 2.5 Flash ⭐", "call": "gemini-2.5-flash",
        "rpm": 10, "rpd": 500, "tpm": 250000,
        "desc": "Лучший баланс — рекомендуется", "provider": "Google"
    },
    "gemini-2.5-flash-lite": {
        "label": "Gemini 2.5 Flash-Lite", "call": "gemini-2.5-flash-lite",
        "rpm": 30, "rpd": 1500, "tpm": 1000000,
        "desc": "Самая быстрая в 2.5", "provider": "Google"
    },
    "gemini-2.5-pro": {
        "label": "Gemini 2.5 Pro", "call": "gemini-2.5-pro",
        "rpm": 5, "rpd": 100, "tpm": 250000,
        "desc": "Самая умная 2.5 👑", "provider": "Google"
    },
    # ===== GOOGLE GEMINI 2.0 =====
    "gemini-2.0-flash": {
        "label": "Gemini 2.0 Flash", "call": "gemini-2.0-flash",
        "rpm": 15, "rpd": 1500, "tpm": 1000000,
        "desc": "1M контекст (deprecated 31.03.26)", "provider": "Google"
    },
    "gemini-2.0-flash-lite": {
        "label": "Gemini 2.0 Flash-Lite", "call": "gemini-2.0-flash-lite",
        "rpm": 30, "rpd": 1500, "tpm": 1000000,
        "desc": "Самая дешёвая 2.0 (deprecated)", "provider": "Google"
    },
    # ===== GOOGLE GEMMA =====
    "gemma-3-27b-it": {
        "label": "Gemma 3 27B", "call": "gemma-3-27b-it",
        "rpm": 2, "rpd": 50, "tpm": 8000,
        "desc": "Мощная open-source модель", "provider": "Google"
    },
    "gemma-3-12b-it": {
        "label": "Gemma 3 12B", "call": "gemma-3-12b-it",
        "rpm": 15, "rpd": 100, "tpm": 15000,
        "desc": "Баланс скорости и качества", "provider": "Google"
    },
    "gemma-3-4b-it": {
        "label": "Gemma 3 4B", "call": "gemma-3-4b-it",
        "rpm": 30, "rpd": 300, "tpm": 30000,
        "desc": "Лёгкая и быстрая", "provider": "Google"
    },
    # ===== GROQ — Meta Llama =====
    "llama-3.3-70b-versatile": {
        "label": "Llama 3.3 70B", "call": "llama-3.3-70b-versatile",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "Мощная, 280 tok/s ⚡", "provider": "Groq"
    },
    "llama-3.1-8b-instant": {
        "label": "Llama 3.1 8B Instant", "call": "llama-3.1-8b-instant",
        "rpm": 30, "rpd": 14400, "tpm": 131072,
        "desc": "560 tok/s, макс запросов 💨", "provider": "Groq"
    },
    "meta-llama/llama-4-maverick-17b-128e-instruct": {
        "label": "Llama 4 Maverick 17B", "call": "meta-llama/llama-4-maverick-17b-128e-instruct",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "Новейший Llama 4, мультимодал", "provider": "Groq"
    },
    "meta-llama/llama-4-scout-17b-16e-instruct": {
        "label": "Llama 4 Scout 17B", "call": "meta-llama/llama-4-scout-17b-16e-instruct",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "Llama 4, 10M токен контекст", "provider": "Groq"
    },
    # ===== GROQ — OpenAI OSS =====
    "openai/gpt-oss-120b": {
        "label": "GPT-OSS 120B", "call": "openai/gpt-oss-120b",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "OpenAI open-weight ~500 tok/s 🔥", "provider": "Groq"
    },
    "openai/gpt-oss-20b": {
        "label": "GPT-OSS 20B", "call": "openai/gpt-oss-20b",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "OpenAI лёгкая ~1000 tok/s", "provider": "Groq"
    },
    # ===== GROQ — DeepSeek =====
    "deepseek-r1-distill-llama-70b": {
        "label": "DeepSeek R1 Llama 70B", "call": "deepseek-r1-distill-llama-70b",
        "rpm": 30, "rpd": 1000, "tpm": 128000,
        "desc": "Reasoning: математика и код 🧠", "provider": "Groq"
    },

    # ===== GROQ — Qwen =====
    "qwen-qwq-32b": {
        "label": "Qwen QwQ 32B", "call": "qwen-qwq-32b",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "Reasoning модель от Alibaba", "provider": "Groq"
    },



    # ===== GROQ — Qwen (актуальные) =====
    "qwen-qwq-32b": {
        "label": "Qwen QwQ 32B", "call": "qwen-qwq-32b",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "Reasoning модель от Alibaba 🧠", "provider": "Groq"
    },
    "qwen/qwen3-32b": {
        "label": "Qwen3 32B 🆕", "call": "qwen/qwen3-32b",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "Новейший Qwen3, 400 tok/s", "provider": "Groq"
    },
    # ===== GROQ — Moonshot =====
    "moonshotai/kimi-k2-instruct-0905": {
        "label": "Kimi K2 🆕", "call": "moonshotai/kimi-k2-instruct-0905",
        "rpm": 30, "rpd": 1000, "tpm": 262144,
        "desc": "262K контекст, агентик 🌙", "provider": "Groq"
    },
    # ===== GROQ — Compound (с поиском в интернете) =====
    "groq/compound": {
        "label": "Compound 🌐 (поиск)", "call": "groq/compound",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "Реальный поиск в интернете 🔍", "provider": "Groq"
    },
    "groq/compound-mini": {
        "label": "Compound Mini 🌐 (поиск)", "call": "groq/compound-mini",
        "rpm": 30, "rpd": 1000, "tpm": 131072,
        "desc": "Поиск в интернете, быстрее", "provider": "Groq"
    },

}

EXCLUDE_LIST = ["RbxCli", "macexploit", "Severe", "Matcha", "Hydrogen", "DX9WARE V2", "Serotonin"]

REPO_CONFIG = {
    "Nexus-Beta-TSB": {"name": "✨ TSB (BETA)", "color": 0x00FFFF},
    "Nexus-Hub-2-SEA": {"name": "🎣 Blox Fruits (Sea 2)", "color": 0xFFA500},
    "Nexus-Hub-Not-Realese-": {"name": "🌊 Blox Fruits (Sea 1)", "color": 0x0000FF},
    "default": {"name": "Nexus Project", "color": 0xcccccc}
}

LANG_EXTENSIONS = {
    "python": ("py", "Python code"), "py": ("py", "Python code"),
    "lua": ("lua", "Lua script"),
    "javascript": ("js", "JavaScript code"), "js": ("js", "JavaScript code"),
    "typescript": ("ts", "TypeScript code"), "ts": ("ts", "TypeScript code"),
    "java": ("java", "Java code"),
    "cpp": ("cpp", "C++ code"), "c++": ("cpp", "C++ code"),
    "c": ("c", "C code"),
    "csharp": ("cs", "CSharp code"), "cs": ("cs", "CSharp code"),
    "html": ("html", "HTML file"), "css": ("css", "CSS file"),
    "bash": ("sh", "Bash script"), "sh": ("sh", "Shell script"),
    "json": ("json", "JSON file"), "sql": ("sql", "SQL script"),
    "rust": ("rs", "Rust code"), "go": ("go", "Go code"),
    "ruby": ("rb", "Ruby code"), "php": ("php", "PHP code"),
    "kotlin": ("kt", "Kotlin code"), "swift": ("swift", "Swift code"),
    "xml": ("xml", "XML file"), "yaml": ("yaml", "YAML file"), "yml": ("yaml", "YAML file"),
}

def extract_code_info(text):
    pattern = r"```(\w*)\n([\s\S]*?)```"
    matches = re.findall(pattern, text)
    if matches:
        lang, code = matches[0]
        return lang.lower().strip(), code.strip()
    return None, None

def get_file_info(lang):
    if lang in LANG_EXTENSIONS:
        ext, label = LANG_EXTENSIONS[lang]
        return ext, label
    return "txt", "Code file"

# --- МИНИ-СЕРВЕР ---
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

# --- СОСТОЯНИЕ ---
last_versions = {"live": db_get("live"), "future": db_get("future")}
last_msg_id = [db_get("last_msg_id")]
exploit_msg_id = [db_get("exploit_msg_id")]

def save_state():
    db_set("live", last_versions["live"])
    db_set("future", last_versions["future"])
    db_set("last_msg_id", last_msg_id[0])
    db_set("exploit_msg_id", exploit_msg_id[0])

# --- ВЕБХУК ---
def send_to_webhook(content, username, avatar_url):
    data = {"content": content, "username": username, "avatar_url": avatar_url}
    requests.post(AI_WEBHOOK_URL, json=data)

def send_file_to_webhook(file_bytes, filename, caption, username, avatar_url):
    files = {"file": (filename, file_bytes, "text/plain")}
    data = {"content": caption, "username": username, "avatar_url": avatar_url}
    requests.post(AI_WEBHOOK_URL, data=data, files=files)

# --- ФУНКЦИЯ ЗАПРОСА К ИИ ---
GEMMA_MODELS = {"gemma-3-27b-it", "gemma-3-12b-it", "gemma-3-4b-it"}

async def _call_model(model_name: str, prompt: str, history: list) -> str:
    """Вызвать конкретную модель. Возвращает текст или бросает исключение."""
    is_gemma = model_name in GEMMA_MODELS
    is_groq  = model_name in GROQ_MODELS

    if is_groq:
        if not groq_client:
            raise ValueError("GROQ_KEY не задан")
        is_compound = model_name in WEB_SEARCH_MODELS
        sys_prompt = SYSTEM_PROMPT_WEB if is_compound else SYSTEM_PROMPT
        messages = [{"role": "system", "content": sys_prompt}]
        for item in history[-(MAX_HISTORY - 2):]:
            role = "assistant" if item["role"] == "model" else "user"
            messages.append({"role": role, "content": item["parts"][0]})
        messages.append({"role": "user", "content": prompt})
        resp = groq_client.chat.completions.create(
            model=model_name, messages=messages,
            max_tokens=4096, temperature=0.8,
        )
        answer = resp.choices[0].message.content
        # Проверяем использовался ли поиск
        used_tools = getattr(resp.choices[0].message, "executed_tools", None) or []
        did_search = any(
            getattr(t, "type", "") in ("web_search", "browser_automation", "visit_website")
            for t in used_tools
        )
        if did_search:
            answer = "🔍 *[поиск в интернете]*\n" + answer
        return answer

    if is_gemma:
        mdl = genai.GenerativeModel(model_name=model_name, generation_config=generation_config)
        actual = f"Отвечай текстом, коротко и по делу. Не пиши код если не просят. Если просят найти что-то в интернете — скажи что у тебя нет доступа в интернет и ответь из своих знаний. Вопрос: {prompt}"
    else:
        mdl = genai.GenerativeModel(model_name=model_name, generation_config=generation_config, system_instruction=SYSTEM_PROMPT)
        actual = prompt

    hist_use = history[:]
    if len(hist_use) > MAX_HISTORY - 2:
        hist_use = hist_use[-(MAX_HISTORY - 2):]
    chat = mdl.start_chat(history=hist_use)
    resp = chat.send_message(actual)
    return resp.text


async def ask_ai(uid, prompt, channel=None):
    """Запрос к ИИ. В авто-режиме перебирает модели при лимите."""
    user_hist = get_user_history(uid)

    # Список моделей для попытки
    if get_auto_mode():
        cur = get_current_model()
        # Начинаем с текущей, потом остальные из списка
        order = [cur] + [m for m in AUTO_FALLBACK_ORDER if m != cur]
    else:
        order = [get_current_model()]

    last_err = "Неизвестная ошибка"
    used_model = order[0]

    for model_name in order:
        try:
            answer_text = await _call_model(model_name, prompt, user_hist)
            used_model = model_name
            break
        except Exception as e:
            err_str = str(e).lower()
            # Пробуем следующую только при ошибках лимита / недоступности
            if any(x in err_str for x in ["429", "quota", "rate", "limit", "503", "overloaded", "unavailable", "resource_exhausted"]):
                last_err = str(e)
                continue
            # Любая другая ошибка — возвращаем сразу
            return False, str(e)
    else:
        return False, f"Все модели недоступны. Последняя ошибка: {last_err}"

    # Сохраняем историю
    user_hist.append({"role": "user",  "parts": [prompt]})
    user_hist.append({"role": "model", "parts": [answer_text]})
    if len(user_hist) > MAX_HISTORY:
        user_hist = user_hist[-MAX_HISTORY:]
    save_user_history(uid, user_hist)

    # В авто-режиме добавляем пометку если использовалась не основная модель
    if get_auto_mode() and used_model != get_current_model():
        m_info = MODELS_INFO.get(used_model, {})
        answer_text += f"\n\n*[авто: использована {m_info.get('label', used_model)}]*"

    return True, answer_text

# --- МОДАЛЬНОЕ ОКНО ДЛЯ ЗАПРОСА К ИИ ---
class AskAIModal(discord.ui.Modal, title="Nexus AI — Задать вопрос"):
    prompt = discord.ui.TextInput(
        label="Твой вопрос или запрос",
        style=discord.TextStyle.paragraph,
        placeholder="Напиши сюда что угодно...",
        required=True,
        max_length=2000
    )

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        uid = interaction.user.id
        success, answer_text = await ask_ai(uid, self.prompt.value)

        if not success:
            await interaction.followup.send(f"❌ Ошибка: {answer_text}", ephemeral=True)
            return

        lang, code = extract_code_info(answer_text)

        text_only = re.sub(r"```[\w]*\n[\s\S]*?```", "", answer_text).strip()
        if code:
            if len(code) < 300:
                # Короткий код — красиво в сообщение
                ext, _ = get_file_info(lang)
                inline = f"```{lang or ext}\n{code}\n```"
                msg = (text_only + "\n" + inline) if text_only else inline
                preview = msg[:1900] + ("..." if len(msg) > 1900 else "")
                await interaction.followup.send(
                    content=f"**Ответ Nexus AI:**\n{preview}",
                    ephemeral=True
                )
            else:
                # Длинный код — файлом
                ext, label = get_file_info(lang)
                filename = f"{label}.{ext}"
                msg = (text_only + "\n*(Код отправлен файлом)*") if text_only else "*(Код отправлен файлом)*"
                import io
                await interaction.followup.send(
                    content=f"**Ответ Nexus AI:**\n{msg}",
                    file=discord.File(fp=io.BytesIO(code.encode('utf-8')), filename=filename),
                    ephemeral=True
                )
        else:
            preview = answer_text[:1900] + ("..." if len(answer_text) > 1900 else "")
            await interaction.followup.send(
                content=f"**Ответ Nexus AI:**\n{preview}",
                ephemeral=True
            )

# --- ПАНЕЛЬ ИИ ---
class AIPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    def is_owner(self, interaction):
        return any(role.id == OWNER_ROLE_ID for role in interaction.user.roles)

    @discord.ui.button(label="Спросить ИИ", style=discord.ButtonStyle.success, custom_id="panel_askai", emoji="💬", row=0)
    async def askai_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(AskAIModal())

    @discord.ui.button(label="Set Model", style=discord.ButtonStyle.primary, custom_id="panel_setmodel", emoji="⚙️", row=1)
    async def setmodel_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.is_owner(interaction):
            return await interaction.response.send_message("❌ Только для Owner.", ephemeral=True)
        m = MODELS_INFO.get(get_current_model(), {})
        label = m.get("label", get_current_model())
        embed = discord.Embed(
            title="⚙️ Смена модели ИИ",
            description=f"Сейчас активна: {label} ({get_current_model()})\n\nВыбери новую модель из списка:",
            color=0x2ecc71
        )
        await interaction.response.send_message(embed=embed, view=ModelSelectView(), ephemeral=True)

    @discord.ui.button(label="Модели", style=discord.ButtonStyle.secondary, custom_id="panel_model", emoji="🤖", row=1)
    async def model_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.is_owner(interaction):
            return await interaction.response.send_message("❌ Только для Owner.", ephemeral=True)
        embed = discord.Embed(title="🤖 Все доступные модели Nexus AI", color=0x3498db)
        cur = get_current_model()
        m_cur = MODELS_INFO.get(cur, {})
        desc = f"**Активная:** `{m_cur.get('label', cur)}` ({m_cur.get('provider','?')})`\n\n"
        desc += "**🌐 Google:**\n"
        for key, m in MODELS_INFO.items():
            if m.get("provider") == "Google":
                desc += f"• **{m['label']}** — {m['desc']} | `{m['rpd']}` req/day\n"
        desc += "\n**⚡ Groq:**\n"
        for key, m in MODELS_INFO.items():
            if m.get("provider") == "Groq":
                desc += f"• **{m['label']}** — {m['desc']} | `{m['rpd']}` req/day\n"
        embed.description = desc[:4000]
        embed.set_footer(text="Сменить модель может только Owner через кнопку Set Model")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="Лимиты", style=discord.ButtonStyle.secondary, custom_id="panel_limit", emoji="📊", row=1)
    async def limit_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.is_owner(interaction):
            return await interaction.response.send_message("❌ Только для Owner.", ephemeral=True)
        m = MODELS_INFO.get(get_current_model())
        embed = discord.Embed(title="📊 Лимиты активной модели", color=0x9b59b6)
        if m:
            embed.description = (
                f"**Модель:** `{m['label']}`\n"
                f"**Статус:** 🟢 Online\n\n"
                f"• Запросов в минуту: **{m['rpm']}**\n"
                f"• Запросов в день: **{m['rpd']}**\n"
                f"• Токенов в минуту: **{m['tpm']:,}**\n\n"
                f"*Лимиты установлены Google AI Free Tier*"
            )
        else:
            embed.description = f"• Модель: **{get_current_model()}**\n• Статус: 🟢 Online\n• Лимиты: неизвестны для этой модели"
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="Last Msg", style=discord.ButtonStyle.secondary, custom_id="panel_lastmsg", emoji="📨", row=1)
    async def lastmsg_btn(self, interaction: discord.Interaction, button: discord.ui.Button):
        uid = interaction.user.id
        hist = get_user_history(uid)  # всегда читаем свежие данные из MongoDB
        if not hist:
            return await interaction.response.send_message("У тебя ещё нет истории диалога.", ephemeral=True)

        # Берём последние 3 пары вопрос/ответ
        pairs = []
        i = len(hist) - 1
        while i >= 0 and len(pairs) < 3:
            if hist[i]["role"] == "model" and i > 0 and hist[i-1]["role"] == "user":
                q = hist[i-1]["parts"][0] if hist[i-1]["parts"] else ""
                a = hist[i]["parts"][0] if hist[i]["parts"] else ""
                pairs.append((q, a))
                i -= 2
            else:
                i -= 1

        pairs.reverse()
        result = "**Последние диалоги с Nexus AI:**\n\n"
        for q, a in pairs:
            q_short = q[:100] + ("..." if len(q) > 100 else "")
            a_short = a[:300] + ("..." if len(a) > 300 else "")
            result += f"❓ **{q_short}**\n💬 {a_short}\n\n"

        if len(result) > 1900:
            result = result[:1900] + "..."
        await interaction.response.send_message(result, ephemeral=True)

# --- МЕНЮ МОДЕЛЕЙ ---
class ModelSelectGoogle(discord.ui.Select):
    def __init__(self):
        options = [
            discord.SelectOption(label="Gemini 3.1 Pro Preview 🆕", value="gemini-3.1-pro-preview", emoji="🏆", description="Новейший • 25 req/day"),
            discord.SelectOption(label="Gemini 3 Flash Preview 🆕", value="gemini-3-flash-preview", emoji="🌟", description="Gemini 3 быстрый • 100 req/day"),
            discord.SelectOption(label="Gemini 2.5 Flash ⭐", value="gemini-2.5-flash", emoji="🔥", description="Рекомендуется • 500 req/day"),
            discord.SelectOption(label="Gemini 2.5 Flash-Lite", value="gemini-2.5-flash-lite", emoji="💨", description="Самая быстрая • 1500 req/day"),
            discord.SelectOption(label="Gemini 2.5 Pro", value="gemini-2.5-pro", emoji="👑", description="Умная 2.5 • 100 req/day"),
            discord.SelectOption(label="Gemini 2.0 Flash", value="gemini-2.0-flash", emoji="⚡", description="1M контекст • 1500 req/day"),
            discord.SelectOption(label="Gemma 3 27B", value="gemma-3-27b-it", emoji="🧬", description="Open-source • 50 req/day"),
            discord.SelectOption(label="Gemma 3 12B", value="gemma-3-12b-it", emoji="🔬", description="Баланс • 100 req/day"),
            discord.SelectOption(label="Gemma 3 4B", value="gemma-3-4b-it", emoji="📱", description="Лёгкая • 300 req/day"),
        ]
        super().__init__(placeholder="🌐 Google модели...", min_values=1, max_values=1, options=options, custom_id="select_google")

    async def callback(self, interaction: discord.Interaction):
        if not any(role.id == OWNER_ROLE_ID for role in interaction.user.roles):
            return await interaction.response.send_message("❌ Нет прав.", ephemeral=True)
        set_current_model(self.values[0])
        m = MODELS_INFO.get(get_current_model(), {})
        lbl = m.get("label", get_current_model())
        web = " 🌐" if get_current_model() in WEB_SEARCH_MODELS else ""
        # edit_message убирает embed+view (меню пропадает), content пустой — ничего не видно
        await interaction.response.edit_message(content=f"✅ **{lbl}{web}**", embed=None, view=None)
        await interaction.delete_original_response()

class ModelSelectGroq(discord.ui.Select):
    def __init__(self):
        options = [
            discord.SelectOption(label="🔍 Compound (поиск в инете)", value="groq/compound", emoji="🌐", description="Реальный веб-поиск • 200 RPM"),
            discord.SelectOption(label="🔎 Compound Mini (поиск)", value="groq/compound-mini", emoji="🌐", description="Поиск, быстрее • 200 RPM"),
            discord.SelectOption(label="Llama 3.3 70B ⭐", value="llama-3.3-70b-versatile", emoji="🦙", description="Рекомендуется • 280 tok/s"),
            discord.SelectOption(label="Llama 3.1 8B Instant", value="llama-3.1-8b-instant", emoji="💨", description="560 tok/s • макс запросов"),
            discord.SelectOption(label="Llama 4 Maverick 17B", value="meta-llama/llama-4-maverick-17b-128e-instruct", emoji="🦙", description="Новейший Llama 4"),
            discord.SelectOption(label="Llama 4 Scout 17B", value="meta-llama/llama-4-scout-17b-16e-instruct", emoji="🔭", description="131K контекст"),
            discord.SelectOption(label="GPT-OSS 120B", value="openai/gpt-oss-120b", emoji="🤖", description="OpenAI open-weight • 500 tok/s"),
            discord.SelectOption(label="GPT-OSS 20B", value="openai/gpt-oss-20b", emoji="⚡", description="OpenAI лёгкая • 1000 tok/s"),
            discord.SelectOption(label="DeepSeek R1 Llama 70B", value="deepseek-r1-distill-llama-70b", emoji="🧠", description="Reasoning: матем и код"),
            discord.SelectOption(label="Qwen QwQ 32B", value="qwen-qwq-32b", emoji="🌟", description="Reasoning от Alibaba"),
            discord.SelectOption(label="Qwen3 32B 🆕", value="qwen/qwen3-32b", emoji="✨", description="Новейший Qwen3 • 400 tok/s"),
            discord.SelectOption(label="Kimi K2 🆕", value="moonshotai/kimi-k2-instruct-0905", emoji="🌙", description="262K контекст"),
        ]
        super().__init__(placeholder="⚡ Groq модели...", min_values=1, max_values=1, options=options, custom_id="select_groq")

    async def callback(self, interaction: discord.Interaction):
        if not any(role.id == OWNER_ROLE_ID for role in interaction.user.roles):
            return await interaction.response.send_message("❌ Нет прав.", ephemeral=True)
        set_current_model(self.values[0])
        m = MODELS_INFO.get(get_current_model(), {})
        lbl = m.get("label", get_current_model())
        web = " 🌐" if get_current_model() in WEB_SEARCH_MODELS else ""
        await interaction.response.edit_message(content=f"✅ **{lbl}{web}** [Groq]", embed=None, view=None)
        await interaction.delete_original_response()

class AutoToggleButton(discord.ui.Button):
    def __init__(self):
        is_on = get_auto_mode()
        super().__init__(
            label=f"🔄 Авто: {'ВКЛ ✅' if is_on else 'ВЫКЛ ❌'}",
            style=discord.ButtonStyle.success if is_on else discord.ButtonStyle.danger,
            custom_id="modelview_auto",
            row=2
        )

    async def callback(self, interaction: discord.Interaction):
        if not any(role.id == OWNER_ROLE_ID for role in interaction.user.roles):
            return await interaction.response.send_message("❌ Нет прав.", ephemeral=True)
        new_state = not get_auto_mode()
        set_auto_mode(new_state)
        status = "✅ ВКЛ" if new_state else "❌ ВЫКЛ"
        cur_label = MODELS_INFO.get(get_current_model(), {}).get("label", get_current_model())
        desc = f"**Авто-режим {status}**\n\nОсновная модель: **{cur_label}**\n\n"
        if new_state:
            desc += "При лимите авто-переключается:\n"
            for i, m in enumerate(AUTO_FALLBACK_ORDER[:8], 1):
                lbl = MODELS_INFO.get(m, {}).get("label", m)
                desc += f"{i}. {lbl}\n"
            desc += "*(и далее...)*"
        embed = discord.Embed(
            title="🔄 Авто-режим моделей",
            description=desc,
            color=0x2ecc71 if new_state else 0xe74c3c
        )
        # Обновляем кнопку без закрытия меню
        new_view = ModelSelectView()
        await interaction.response.edit_message(view=new_view)
        await interaction.followup.send(embed=embed, ephemeral=True)


class ModelSelectView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=60)
        self.add_item(ModelSelectGoogle())
        self.add_item(ModelSelectGroq())
        self.add_item(AutoToggleButton())

# --- КНОПКИ ИСТОРИИ И РОЛЕЙ ---
class HistoryView(View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Show History", style=discord.ButtonStyle.secondary, custom_id="btn_history")
    async def show_history(self, interaction: discord.Interaction, button: discord.ui.Button):
        vh = get_version_history()
        if not vh:
            return await interaction.response.send_message("History is empty.", ephemeral=True)
        h_list = "**Last 10 recorded versions:**\n\n"
        for v in vh[-10:]:
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

# --- ПАНЕЛЬ В AI КАНАЛЕ ---
async def ensure_ai_panel(channel):
    panel_msg_id = db_get("ai_panel_msg_id")
    if panel_msg_id:
        try:
            await channel.fetch_message(panel_msg_id)
            return  # Панель уже существует
        except:
            db_set("ai_panel_msg_id", None)

    # Ищем существующую панель в истории
    async for msg in channel.history(limit=50):
        if msg.author == bot.user and msg.embeds:
            title = msg.embeds[0].title or ""
            if "Nexus AI" in title and "Panel" in title:
                db_set("ai_panel_msg_id", msg.id)
                return

    # Создаём новую панель
    embed = discord.Embed(
        title="🤖 Nexus AI | Panel",
        description=(
            "**Способы общения с ИИ:**\n"
            "┣ Кнопка **💬 Спросить ИИ** — ответ только тебе (приватно)\n"
            "┗ Команда **`?ai <вопрос>`** — ответ в чат через вебхук\n\n"
            "**`?clear`** — очистить свою историю диалога\n\n"
            "**Кнопки панели:**\n"
            "💬 **Спросить ИИ** — задать вопрос приватно\n"
            "⚙️ **Set Model** — сменить модель *(Owner)*\n"
            "🤖 **Модели** — все доступные модели *(Owner)*\n"
            "📊 **Лимиты** — лимиты активной модели *(Owner)*\n"
            "📨 **Last Msg** — твой последний ответ от ИИ\n"
            "\n"
            "*ИИ помнит историю отдельно для каждого пользователя.*"
        ),
        color=0x00FBFF
    )
    embed.set_footer(text="Nexus Core | AI System")
    msg = await channel.send(embed=embed, view=AIPanelView())
    db_set("ai_panel_msg_id", msg.id)

# --- ОБРАБОТКА СООБЩЕНИЙ ---
@bot.event
async def on_message(message):
    if message.author == bot.user:
        return

    if message.channel.id == AI_CHANNEL_ID:
        content = message.content.lower()

        # !panel — пропускаем в process_commands, не удаляем
        if content.startswith('!panel'):
            await bot.process_commands(message)
            return

        # ?ai команда — ответ в чат через вебхук
        if content.startswith(('?ai ', '?аи ')):
            prompt = message.content[4:].strip()
            if not prompt:
                try: await message.delete()
                except: pass
                return
            try:
                await message.delete()
            except:
                pass

            async with message.channel.typing():
                success, answer_text = await ask_ai(message.author.id, prompt)
                if not success:
                    await message.channel.send(
                        f"❌ Ошибка Nexus AI (Модель: `{get_current_model()}`): {answer_text}",
                        delete_after=15
                    )
                    return

                lang, code = extract_code_info(answer_text)
                caption = f"**Ответ для {message.author.mention}:**"

                text_only = re.sub(r"```[\w]*\n[\s\S]*?```", "", answer_text).strip()
                if code:
                    if len(code) < 300:
                        # Короткий код — красиво inline
                        ext, _ = get_file_info(lang)
                        inline = f"```{lang or ext}\n{code}\n```"
                        msg = (text_only + "\n" + inline) if text_only else inline
                        full = f"{caption}\n{msg}"
                        if len(full) > 1990:
                            for i in range(0, len(full), 1990):
                                send_to_webhook(full[i:i+1990], "Nexus AI", AI_AVATAR_URL)
                        else:
                            send_to_webhook(full, "Nexus AI", AI_AVATAR_URL)
                    else:
                        # Длинный код — файлом
                        ext, label = get_file_info(lang)
                        filename = f"{label}.{ext}"
                        if text_only:
                            caption += f"\n{text_only}"
                        caption += "\n*(Код отправлен файлом)*"
                        send_file_to_webhook(code.encode("utf-8"), filename, caption, "Nexus AI", AI_AVATAR_URL)
                else:
                    full_answer = f"{caption}\n{answer_text}"
                    if len(full_answer) > 1990:
                        for i in range(0, len(full_answer), 1990):
                            send_to_webhook(full_answer[i:i+1990], "Nexus AI", AI_AVATAR_URL)
                    else:
                        send_to_webhook(full_answer, "Nexus AI", AI_AVATAR_URL)
            return

        # ?clear команда
        if content.startswith(('?clear', '?клир')):
            try:
                await message.delete()
            except:
                pass
            delete_user_history(message.author.id)
            await message.channel.send(
                f"✅ {message.author.mention}, история диалога очищена.",
                delete_after=8
            )
            return

        # Любое другое сообщение в AI канале — удаляем чтобы не засорять
        try:
            await message.delete()
        except:
            pass
        return

    await bot.process_commands(message)

# --- КОМАНДЫ ---
@bot.command()
async def panel(ctx):
    """Пересоздать/обновить панель ИИ — только для Owner"""
    if ctx.channel.id != AI_CHANNEL_ID:
        return
    try:
        await ctx.message.delete()
    except:
        pass
    # Проверка роли Owner
    if not any(role.id == OWNER_ROLE_ID for role in ctx.author.roles):
        return

    # Удаляем старую панель если есть
    panel_msg_id = db_get("ai_panel_msg_id")
    if panel_msg_id:
        try:
            old_msg = await ctx.channel.fetch_message(panel_msg_id)
            await old_msg.delete()
        except:
            pass
        db_set("ai_panel_msg_id", None)

    # Создаём новую
    await ensure_ai_panel(ctx.channel)

@bot.command()
@commands.has_permissions(administrator=True)
async def init_roles(ctx):
    if ctx.channel.id != ROLE_CHANNEL_ID:
        return await ctx.send(f"Эту команду можно использовать только в <#{ROLE_CHANNEL_ID}>")
    embed = discord.Embed(
        title="🔔 Nexus Core | Notifications",
        description=(
            "Выберите роли для уведомлений:\n\n"
            "🔹 **Executer UPD** — Статусы читов\n"
            "🟢 **Roblox UPD** — Обновления Roblox\n"
            "🔴 **Script UPD** — Обновления скриптов"
        ),
        color=0x2b2d31
    )
    await ctx.send(embed=embed, view=RoleView())
    await ctx.message.delete()

@bot.command()
async def version(ctx):
    try:
        await ctx.message.delete()
    except:
        pass
    live = get_roblox_v("live")
    if live:
        await update_roblox_msg(ctx.channel, live, live)

async def send_github_update(info, commit_text, author):
    channel = bot.get_channel(UPDATE_CHANNEL_ID)
    if not channel:
        return
    lines = commit_text.split('\n')
    version_label = lines[0] if lines else "Alpha v1"
    formatted_logs = []
    for line in lines[1:]:
        if not line.strip():
            continue
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
    if not channel:
        return
    try:
        r = requests.get("https://weao.xyz/api/status/exploits", timeout=10, headers={'User-Agent': 'WEAO-3PService'})
        if r.status_code != 200:
            return
        data = r.json()
    except:
        return

    embed = discord.Embed(title="🛡️ Nexus Exploit Status", color=0x00FBFF)
    status_text = ""
    for entry in data:
        name = entry.get("title", "Unknown")
        if name in EXCLUDE_LIST:
            continue
        is_updated = entry.get("updateStatus", False)
        version = entry.get("version", "N/A")
        is_detected = entry.get("detected", False)
        emoji = "🟢" if is_updated else "🔴"
        detect_warn = "⚠️" if is_detected else ""
        status_text += f"{emoji} **{name}**: `{'Working' if is_updated else 'Patched'}` {detect_warn} | (v{version})\n"

    embed.description = status_text if status_text else "No data available."
    embed.set_footer(text=f"Sync: {time.strftime('%H:%M:%S')} | Powered by WEAO")

    if not exploit_msg_id[0]:
        async for msg in channel.history(limit=10):
            if msg.author == bot.user and msg.embeds and "🛡️ Nexus Exploit Status" in str(msg.embeds[0].title):
                exploit_msg_id[0] = msg.id
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

    save_state()

def get_roblox_v(channel="live"):
    url = f"https://clientsettings.roblox.com/v2/client-version/WindowsPlayer{'' if channel == 'live' else '/channel/znext'}?t={int(time.time())}"
    try:
        r = requests.get(url, timeout=10, headers={'User-Agent': 'Mozilla/5.0'})
        return r.json().get("clientVersionUpload") if r.status_code == 200 else None
    except:
        return None

async def update_roblox_msg(channel, live, future, is_update=False):
    vh = get_version_history()
    if live and live not in vh:
        vh.append(live)
        if len(vh) > 20:
            vh.pop(0)
        save_version_history(vh)

    if not last_msg_id[0]:
        async for m in channel.history(limit=10):
            if m.author == bot.user and m.embeds and "Roblox" in str(m.embeds[0].title):
                last_msg_id[0] = m.id
                break

    embed = discord.Embed(title="Roblox Status", color=0x2ecc71)
    embed.add_field(
        name="Current Live Hash:",
        value=f"`{live}`\n[Download](https://rdd.whatexpsare.online/?channel=LIVE&binaryType=WindowsPlayer&version={live})",
        inline=False
    )
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

    save_state()

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
    bot.add_view(AIPanelView())
    if not check_roblox.is_running():
        check_roblox.start()
    if not check_exploits.is_running():
        check_exploits.start()
    ai_channel = bot.get_channel(AI_CHANNEL_ID)
    if ai_channel:
        await ensure_ai_panel(ai_channel)

if __name__ == "__main__":
    Thread(target=run_flask).start()
    bot.run(TOKEN)
