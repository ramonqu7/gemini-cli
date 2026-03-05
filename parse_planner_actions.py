import json
import sys
import re

# Load the query output
try:
    with open('/usr/local/google/home/ramonqu/.gemini/tmp/gemini-cli/tool-outputs/session-aeba609f-f499-420b-9271-744739a11381/f1__execute_query_1772705571216_0.txt', 'r') as f:
        content = f.read()
except Exception as e:
    print(f"Error reading file: {e}")
    sys.exit(1)

def extract_json(job_id):
    # Regex to find the job ID followed by the JSON string
    pattern = rf'{job_id}\s+(\{{.*\}})'
    match = re.search(pattern, content)
    if match:
        return match.group(1)
    return None

def analyze_actions(job_name, json_str):
    print(f"--- {job_name} ---")
    if not json_str:
        print("  No data found or invalid format.")
        return
        
    try:
        data = json.loads(json_str)
        # Navigate nested structure
        actions = data.get('plannerStatistics', {}).get('planGuideStatistics', {}).get('plannerActions', [])
        
        found = False
        for action in actions:
            name = action.get('name', '')
            if 'Superluminal' in name or 'FlattenCompute' in name:
                reason = action.get('reason', '')
                print(f"  - {name}: {reason}")
                found = True
        
        if not found:
            print("  No relevant planner actions found (Superluminal / FlattenCompute).")
            
    except Exception as e:
        print(f"  Error parsing JSON: {e}")

# Parse the latest jobs mentioned in comment 90
slow_id = 'script_job_82d0bd0c70fdc924dfec076eec435c53_1'
fast_id = 'script_job_3768d3cc214b60efd91bd76b83465463_1'

slow_json = extract_json(slow_id)
fast_json = extract_json(fast_id)

analyze_actions(f"Slow Job ({slow_id})", slow_json)
analyze_actions(f"Fast Job ({fast_id})", fast_json)

