import json
import os

try:
    with open('stops.txt', 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Minimize data
    lite_data = []
    for stop in data:
        lite_data.append({
            'i': stop['stop_id'],
            'n': stop['name'],
            'l': stop['lat'],
            'o': stop['lon'],
            'c': stop.get('locality', '')
        })
    
    with open('stops_lite.json', 'w', encoding='utf-8') as f:
        json.dump(lite_data, f, separators=(',', ':'))
        
    print(f"Optimization complete. Original size: {os.path.getsize('stops.txt')/1024/1024:.2f}MB")
    print(f"New size: {os.path.getsize('stops_lite.json')/1024/1024:.2f}MB")

except Exception as e:
    print(f"Error: {e}")
