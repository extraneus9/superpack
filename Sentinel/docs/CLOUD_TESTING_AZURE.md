# Testing Sentinel on a free Azure Windows VM

A throwaway Windows in the cloud — fully separate from your PC, no restart needed. Free on
Azure's **$200 credit** (first 30 days). A card is needed to register but is **not charged**
within the credit.

> ⚠ **Delete the VM when you finish.** A running VM spends credit around the clock. A few
> hours of testing costs ~$1–2; a forgotten VM can drain the whole $200.

Sentinel only **scans** files, it never runs them — and this VM is isolated from your machine,
so it's safe to put real samples on it.

---

## 1. Make the account
Go to **https://azure.microsoft.com/free** → "Start free" → sign in / create a Microsoft
account → add a card (not charged on the free credit). You get **$200 for 30 days**.

## 2. Create the VM (portal)
Azure Portal → **Create a resource → Virtual machine**:
- **Resource group:** `SentinelTest` (create new — lets you delete everything in one click later)
- **Name:** `sentinel-vm`
- **Image:** **Windows Server 2022 Datacenter** (freely available)
- **Size:** `Standard_B2s` (2 vCPU, 4 GB — cheap and enough)
- **Username / password:** set your own (remember them)
- **Inbound ports:** allow **RDP (3389)**
- Create. Wait ~2–3 min.

## 3. Connect
On the VM page → **Connect → RDP → Download RDP file** → open it → log in with the
username/password. (Use Windows' built-in **Remote Desktop Connection**.)

**Tip — bring Sentinel.exe over the easy way:** before connecting, in Remote Desktop
Connection → **Show Options → Local Resources → More… → Drives → tick your C: drive**. Inside
the VM you'll then see your PC's drive under "This PC" and can copy `dist\Sentinel.exe` across.

## 4. Prep the VM
Inside the VM:
- Install the **Microsoft Edge WebView2 Runtime** (so Sentinel's window renders on Server):
  download the "Evergreen Standalone Installer" from
  `https://developer.microsoft.com/microsoft-edge/webview2/` and run it. (On Windows 11 it's
  already there; on Server you add it once.)
- Turn the VM's **Windows Defender real-time protection OFF** (Windows Security → Virus &
  threat protection), so **Sentinel** does the detecting.

## 5. Test
- Copy **Sentinel.exe** onto the VM (via the shared drive from step 3) and run it.
- Set **VT_API_KEY** on the VM if you want the VirusTotal layer: open PowerShell →
  `setx VT_API_KEY "your-key"` → reopen the app.
- Download samples from **MalwareBazaar** (`https://bazaar.abuse.ch`, zip password `infected`)
  into a folder like `C:\samples`.
- In Sentinel → **Full / Custom scan → C:\samples** → read the detection results.
  (Or copy the whole repo + install Python and run `python tools/benchmark.py C:\samples`
  for a precision/recall report.)

## 6. DELETE everything (important)
Azure Portal → **Resource groups → SentinelTest → Delete resource group**. That removes the
VM, disk, IP — and the spending stops.

---

### Fast path with the CLI (Azure Cloud Shell — the `>_` icon in the portal, no install)
```bash
az group create -n SentinelTest -l eastus
az vm create -g SentinelTest -n sentinel-vm --image Win2022Datacenter \
  --size Standard_B2s --admin-username azureuser --admin-password '<ChooseAStr0ng!Pass>' \
  --public-ip-sku Standard
az vm open-port -g SentinelTest -n sentinel-vm --port 3389
# ... it prints the public IP; RDP to it, test ...
# when done, ONE command tears it all down:
az group delete -n SentinelTest --yes --no-wait
```
