cat << 'EOF' > /sdcard/Download/bin/quest.py
import glob, os, sqlite3, subprocess, time

G = "\033[1;32m"; Y = "\033[1;33m"; C = "\033[1;36m"; W = "\033[1;37m"; M = "\033[1;35m"; R = "\033[1;31m"; NC = "\033[0m"

os.chdir("/data/data/com.termux/files/home/google_play_achievement_unlocker")

# অটো ডাটাবেজ ডিটেকশন
try:
    db = sorted(glob.glob("/data/data/com.google.android.gms/databases/games_*.db"), key=os.path.getmtime)[-1]
except:
    print(f"{R}✖ Google Play Games Database not found!{NC}")
    exit()

g, e = "Unknown Gamer", "No Email Found"
try:
    c = sqlite3.connect(db)
    r1 = c.execute("SELECT profile_name FROM players LIMIT 1").fetchone()
    if r1: g = r1[0]
    r2 = c.execute("SELECT account_name FROM client_contexts LIMIT 1").fetchone()
    if r2: e = r2[0]
    c.close()
except:
    pass

os.system("clear")
print(f"{C}╔══════════════════════════════════════════════════════╗{NC}")
print(f"{W}         GOOGLE PLAY POINTS 100% AUTO-TOOL PANEL       {NC}")
print(f"{M}                  Dev by VAREON STUDIO                 {NC}")
print(f"{C}╚══════════════════════════════════════════════════════╝{NC}")
print(f"{Y}👤 Gamer Name : {W}{g}{NC}")
print(f"{Y}📧 Email Addr : {W}{e}{NC}")
print(f"{Y}📁 Active DB  : {C}{os.path.basename(db)}{NC}")
print(f"{C}──────────────────────────────────────────────────────{NC}")
print(f"{G} Select Target Quest / Game:{NC}")
print(f"{W}  [1] Gossip Harbor (50 Play Points - Full Automation){NC}")
print(f"{R}  [0] Exit Panel{NC}")
print(f"{C}──────────────────────────────────────────────────────{NC}")
print(f"{M} 👑 Owner : {W}Shezin Boy {C}(@Blackmoney54){NC}")
print(f"{C}──────────────────────────────────────────────────────{NC}")

choice = input(f"{Y}Enter your choice (0-1): {NC}").strip()

if choice == "1":
    print(f"\n{C}⏳ [1/6] Launching Game first to register Account & Sync DB (6s)...{NC}")
    subprocess.run("su -c 'am start --user 0 -n com.mergegames.gossipharbor/.SplashActivity'", shell=True, capture_output=True)
    time.sleep(6)
    subprocess.run("su -c 'am force-stop com.mergegames.gossipharbor'", shell=True, capture_output=True)

    print(f"{Y}⚡ [2/6] Injecting Unlocked Achievements directly into Database...{NC}")
    conn = sqlite3.connect(db)
    cursor = conn.cursor()
    
    player_id = cursor.execute("SELECT external_player_id FROM players LIMIT 1").fetchone()[0]
    now = int(time.time() * 1000)

    achs = [
        ('CgkI3YvxrpUIEAIQAQ', 5, '5/5'), # Starter Snack Bar
        ('CgkI3YvxrpUIEAIQBw', 0, ''),    # Welcome to Brimwave
        ('CgkI3YvxrpUIEAIQDA', 0, '')     # Leveled Up
    ]

    for a_id, steps, formatted in achs:
        cursor.execute('''
            INSERT OR REPLACE INTO achievement_instances 
            (definition_id, player_id, state, current_steps, formatted_current_steps, last_updated_timestamp, instance_xp_value)
            VALUES (?, ?, 0, ?, ?, ?, 1000)
        ''', (a_id, player_id, steps, formatted, now))

        cursor.execute('''
            INSERT OR REPLACE INTO achievement_pending_ops 
            (client_context_id, external_achievement_id, achievement_type, new_state, steps_to_increment, min_steps_to_set, external_game_id, external_player_id)
            VALUES (1, ?, 0, 0, ?, ?, '13', ?)
        ''', (a_id, steps, steps, player_id))

    conn.commit()
    conn.close()
    print(f"   {G}★ 3 Quests Unlocked & Added to Cloud Queue!{NC}")

    print(f"{C}🔄 [3/6] Force Syncing with Google Play Cloud Servers...{NC}")
    subprocess.run("su -c 'am broadcast -a com.google.android.gms.games.SYNC --user 0'", shell=True, capture_output=True)

    print(f"{M}🎮 [4/6] Re-opening Game to Trigger Achievement Banners (8s)...{NC}")
    subprocess.run("su -c 'am start --user 0 -n com.mergegames.gossipharbor/.SplashActivity'", shell=True, capture_output=True)
    time.sleep(8)
    subprocess.run("su -c 'am force-stop com.mergegames.gossipharbor'", shell=True, capture_output=True)

    print(f"{G}📲 [5/6] Opening Google Play Games to verify Quest completion...{NC}")
    subprocess.run("su -c 'am start --user 0 -n com.google.android.play.games/.ui.destination.main.MainActivity'", shell=True, capture_output=True)

    print(f"\n{G}╔══════════════════════════════════════════════════════╗{NC}")
    print(f"{W}║  ✔ 100% AUTOMATION COMPLETED SUCCESSFULLY!           ║{NC}")
    print(f"{Y}║  👉 Points are synced! Claim your 50 Points now!     ║{NC}")
    print(f"{G}╚══════════════════════════════════════════════════════╝{NC}\n")

else:
    print(f"\n{Y}Exiting panel. Have a nice day!{NC}\n")
EOF
