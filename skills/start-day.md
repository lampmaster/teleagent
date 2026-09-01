---
name: start-day
description: Run the standard start-of-day routine.
---

# Start Day

Perform the following steps in order, executing every command with the `exec` tool.

## 1. Weather in Berlin

Run:

curl https://wttr.in/Berlin

Return the wttr.in output without processing it.

## 2. Largest process by memory

Run:

ps -axo pid,comm,%mem | sort -k3 -nr | head -n 2

Use the result to report the process name, PID, and memory usage.

## 3. System date

Run:

date

Use the result to report the current system date, time, and timezone.
