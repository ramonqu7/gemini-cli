import urllib.request
import urllib.parse
import re

# Fetch the global routing map for reservations
def check_assignment():
    try:
        url = "https://blade.corp.google.com/bigquery-prod-capacitymgmt-warden-us/assignment_map"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
            
            # Find our reservation
            pattern = r'bi-meli-core.*?</tr>'
            match = re.search(pattern, html, re.DOTALL | re.IGNORECASE)
            if match:
                print(f"Found assignment for bi-meli-core:")
                # Strip HTML tags
                text = re.sub(r'<[^>]+>', ' ', match.group(0))
                print(text.strip())
            else:
                print("bi-meli-core not found in Warden US assignment map!")
    except Exception as e:
        print(f"Error fetching assignment map: {e}")

check_assignment()
