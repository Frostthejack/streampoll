Add-Type -AssemblyName System.Net.WebSockets.Client

$token = "bbeeede00a37f9cfe71638aad2304c9ab518aaef"
$uri = [Uri]"wss://chat.api.restream.io/ws?accessToken=$token"

Write-Host "=== Restream WebSocket Raw Test ===" -ForegroundColor Cyan
Write-Host "Connecting..." -ForegroundColor Yellow

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$cts = [System.Threading.CancellationTokenSource]::new()
$cts.CancelAfter(90000)  # 90 second timeout

$connectTask = $ws.ConnectAsync($uri, $cts.Token)
$connectTask.GetAwaiter().GetResult()

if ($ws.State -ne 'Open') {
    Write-Host "FAILED: $($ws.State)" -ForegroundColor Red; exit
}

Write-Host "Connected! NOW SEND A CHAT MESSAGE in Restream dashboard. Listening 90s..." -ForegroundColor Green

$buffer = New-Object byte[] 65536
$msgBuffer = ""

while ($ws.State -eq 'Open' -and -not $cts.IsCancellationRequested) {
    try {
        $seg = [ArraySegment[byte]]::new($buffer)
        $result = $ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
        
        if ($result.MessageType -eq 'Close') {
            Write-Host "Server closed connection" -ForegroundColor Red
            break
        }
        
        $chunk = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
        $msgBuffer += $chunk
        
        if ($result.EndOfMessage) {
            $ts = Get-Date -Format "HH:mm:ss"
            $action = if ($msgBuffer -match '"action":"([^"]+)"') { $Matches[1] } else { "unknown" }
            
            if ($action -eq "heartbeat") {
                Write-Host "[$ts] heartbeat" -ForegroundColor DarkGray
            } else {
                Write-Host "[$ts] ACTION=$action" -ForegroundColor Green
                Write-Host "FULL MSG: $msgBuffer" -ForegroundColor White
            }
            $msgBuffer = ""
        }
    } catch {
        if ($cts.IsCancellationRequested) { Write-Host "Timeout reached." -ForegroundColor Yellow }
        else { Write-Host "Error: $_" -ForegroundColor Red }
        break
    }
}

Write-Host "Done." -ForegroundColor Cyan
try { $ws.Dispose() } catch {}
