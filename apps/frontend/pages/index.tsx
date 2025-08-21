import { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';

export default function Home() {
	const [mounted, setMounted] = useState(false);
	const [serviceStatus, setServiceStatus] = useState<{
		frontend: 'checking' | 'online' | 'offline';
		signaling: 'checking' | 'online' | 'offline';
		inference: 'checking' | 'online' | 'offline';
	}>({
		frontend: 'checking',
		signaling: 'checking',
		inference: 'checking'
	});

	// Set mounted state after component mounts
	useEffect(() => {
		setMounted(true);
	}, []);

	const { senderUrl, viewerWasmUrl, viewerServerUrl, qrSenderSrc, qrViewerWasmSrc, qrViewerServerSrc, localIp } = useMemo(() => {
		// Return empty values during SSR to prevent hydration mismatch
		if (typeof window === 'undefined') return { 
			senderUrl: '#', 
			viewerWasmUrl: '#', 
			viewerServerUrl: '#', 
			qrSenderSrc: '', 
			qrViewerWasmSrc: '', 
			qrViewerServerSrc: '',
			localIp: 'localhost'
		};
		
		const host = window.location.host; // includes port
		const proto = window.location.protocol; // http:
		const base = `${proto}//${host}`;
		const sig = `ws://${host.split(':')[0]}:8080`;
		const server = `ws://${host.split(':')[0]}:8000/detect`;
		const senderUrl = `${base}/sender?room=room-1&sig=${encodeURIComponent(sig)}`;
		const viewerWasmUrl = `${base}/viewer?room=room-1&sig=${encodeURIComponent(sig)}&mode=wasm`;
		const viewerServerUrl = `${base}/viewer?room=room-1&sig=${encodeURIComponent(sig)}&mode=server&server=${encodeURIComponent(server)}`;
		
		// Generate QR codes for all URLs
		const qrSenderSrc = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(senderUrl)}`;
		const qrViewerWasmSrc = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(viewerWasmUrl)}`;
		const qrViewerServerSrc = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(viewerServerUrl)}`;
		
		return { 
			senderUrl, 
			viewerWasmUrl, 
			viewerServerUrl, 
			qrSenderSrc, 
			qrViewerWasmSrc, 
			qrViewerServerSrc,
			localIp: host.split(':')[0]
		};
	}, []);

	// Check service status
	useEffect(() => {
		if (!mounted) return; // Don't check services until mounted
		
		const checkServices = async () => {
			try {
				// Check frontend (self)
				setServiceStatus(prev => ({ ...prev, frontend: 'online' }));
				
				// Check signaling server
				try {
					const sigResponse = await fetch(`http://${localIp}:8080/`);
					setServiceStatus(prev => ({ ...prev, signaling: sigResponse.ok ? 'online' : 'offline' }));
				} catch {
					setServiceStatus(prev => ({ ...prev, signaling: 'offline' }));
				}
				
				// Check inference server
				try {
					const infResponse = await fetch(`http://${localIp}:8000/`);
					setServiceStatus(prev => ({ ...prev, inference: infResponse.ok ? 'online' : 'offline' }));
				} catch {
					setServiceStatus(prev => ({ ...prev, inference: 'offline' }));
				}
			} catch (error) {
				console.error('Service check failed:', error);
			}
		};

		checkServices();
		const interval = setInterval(checkServices, 10000); // Check every 10 seconds
		return () => clearInterval(interval);
	}, [localIp, mounted]);

	const getStatusIcon = (status: string) => {
		switch (status) {
			case 'online': return '🟢';
			case 'offline': return '🔴';
			case 'checking': return '🟡';
			default: return '⚪';
		}
	};

	return (
		<div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 1200, margin: '0 auto' }}>
			<div style={{ textAlign: 'center', marginBottom: 32 }}>
				<h1 style={{ color: '#2c3e50', marginBottom: 8 }}>🚀 WebRTC VLM Multi-Object Detection</h1>
				<p style={{ color: '#7f8c8d', fontSize: 18 }}>Real-time phone-to-browser object detection with WebRTC</p>
			</div>

			{/* Service Status */}
			<div style={{ 
				background: '#f8f9fa', 
				padding: 16, 
				borderRadius: 8, 
				marginBottom: 24,
				border: '1px solid #e9ecef'
			}}>
				<h3 style={{ margin: '0 0 12px 0', color: '#495057' }}>Service Status</h3>
				<div style={{ display: 'flex', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<span>{getStatusIcon(serviceStatus.frontend)}</span>
						<span>Frontend</span>
					</div>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<span>{getStatusIcon(serviceStatus.signaling)}</span>
						<span>Signaling</span>
					</div>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<span>{getStatusIcon(serviceStatus.inference)}</span>
						<span>Inference</span>
					</div>
				</div>
			</div>

			{/* Quick Start Guide */}
			<div style={{ 
				background: '#e8f5e8', 
				padding: 20, 
				borderRadius: 8, 
				marginBottom: 32,
				border: '1px solid #c3e6c3'
			}}>
				<h3 style={{ margin: '0 0 16px 0', color: '#2d5a2d' }}>📱 Quick Start (5 minutes)</h3>
				<ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
					<li><strong>Start Services:</strong> Run <code>start.bat</code> (Windows) or <code>./start.sh</code> (Linux/Mac)</li>
					<li><strong>Connect Phone:</strong> Scan the QR code below with your phone camera</li>
					<li><strong>Allow Camera:</strong> Grant camera permission when prompted</li>
					<li><strong>Open Viewer:</strong> Click one of the viewer links below on your laptop</li>
					<li><strong>Start Detection:</strong> Click "Start Metrics" in the viewer to begin</li>
				</ol>
			</div>

			{/* Main Interface */}
			<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 32 }}>
				{/* Phone Sender Section */}
				<div style={{ 
					background: '#fff', 
					padding: 24, 
					borderRadius: 12, 
					border: '2px solid #3498db',
					textAlign: 'center'
				}}>
					<h2 style={{ color: '#2980b9', margin: '0 0 16px 0' }}>📱 Phone Sender</h2>
					<p style={{ color: '#7f8c8d', marginBottom: 20 }}>Scan this QR code with your phone to start streaming</p>
					
					{/* Only show QR code after component is mounted to prevent hydration mismatch */}
					{mounted && qrSenderSrc && (
						<div style={{ marginBottom: 20 }}>
							<img 
								src={qrSenderSrc} 
								alt="Phone Sender QR Code" 
								width={200} 
								height={200} 
								style={{ 
									border: '2px solid #3498db', 
									borderRadius: 12,
									boxShadow: '0 4px 12px rgba(52, 152, 219, 0.2)'
								}} 
							/>
						</div>
					)}
					
					{/* Show loading state during SSR */}
					{!mounted && (
						<div style={{ 
							marginBottom: 20, 
							width: 200, 
							height: 200, 
							background: '#f8f9fa', 
							border: '2px solid #3498db', 
							borderRadius: 12,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							color: '#7f8c8d'
						}}>
							Loading QR Code...
						</div>
					)}
					
					<div style={{ marginBottom: 16 }}>
						<a 
							href={mounted ? senderUrl : '#'}
							style={{
								display: 'inline-block',
								padding: '12px 24px',
								background: '#3498db',
								color: 'white',
								textDecoration: 'none',
								borderRadius: 8,
								fontWeight: 'bold',
								transition: 'background 0.2s'
							}}
							onMouseOver={(e) => e.currentTarget.style.background = '#2980b9'}
							onMouseOut={(e) => e.currentTarget.style.background = '#3498db'}
						>
							📱 Open Sender
						</a>
					</div>
					
					<details style={{ textAlign: 'left', marginTop: 16 }}>
						<summary style={{ cursor: 'pointer', color: '#7f8c8d' }}>📋 Direct URL</summary>
						<code style={{ 
							display: 'block', 
							background: '#f8f9fa', 
							padding: 8, 
							borderRadius: 4, 
							marginTop: 8,
							fontSize: 12,
							wordBreak: 'break-all'
						}}>
							{mounted ? senderUrl : 'Loading...'}
						</code>
					</details>
				</div>

				{/* Viewer Section */}
				<div style={{ 
					background: '#fff', 
					padding: 24, 
					borderRadius: 12, 
					border: '2px solid #27ae60'
				}}>
					<h2 style={{ color: '#229954', margin: '0 0 16px 0', textAlign: 'center' }}>💻 Laptop Viewer</h2>
					
					{/* WASM Mode */}
					<div style={{ marginBottom: 24, textAlign: 'center' }}>
						<h3 style={{ color: '#27ae60', margin: '0 0 12px 0' }}>🔧 WASM Mode (Low Resource)</h3>
						<p style={{ color: '#7f8c8d', fontSize: 14, marginBottom: 16 }}>
							Runs inference in your browser. Good for laptops without GPU.
						</p>
						{/* Only show QR code after component is mounted */}
						{mounted && qrViewerWasmSrc && (
							<img 
								src={qrViewerWasmSrc} 
								alt="WASM Viewer QR Code" 
								width={120} 
								height={120} 
								style={{ 
									border: '1px solid #27ae60', 
									borderRadius: 8,
									marginBottom: 12
								}} 
							/>
						)}
						{/* Show loading state during SSR */}
						{!mounted && (
							<div style={{ 
								width: 120, 
								height: 120, 
								background: '#f8f9fa', 
								border: '1px solid #27ae60', 
								borderRadius: 8,
								marginBottom: 12,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								fontSize: 10,
								color: '#7f8c8d'
							}}>
								Loading...
							</div>
						)}
						<div>
							<a 
								href={mounted ? viewerWasmUrl : '#'}
								style={{
									display: 'inline-block',
									padding: '10px 20px',
									background: '#27ae60',
									color: 'white',
									textDecoration: 'none',
									borderRadius: 6,
									fontWeight: 'bold',
									fontSize: 14,
									transition: 'background 0.2s'
								}}
								onMouseOver={(e) => e.currentTarget.style.background = '#229954'}
								onMouseOut={(e) => e.currentTarget.style.background = '#27ae60'}
							>
								🔧 Open WASM Viewer
							</a>
						</div>
					</div>

					{/* Server Mode */}
					<div style={{ textAlign: 'center' }}>
						<h3 style={{ color: '#e74c3c', margin: '0 0 12px 0' }}>🚀 Server Mode (High Performance)</h3>
						<p style={{ color: '#7f8c8d', fontSize: 14, marginBottom: 16 }}>
							Uses backend server for inference. Better performance and accuracy.
						</p>
						{/* Only show QR code after component is mounted */}
						{mounted && qrViewerServerSrc && (
							<img 
								src={qrViewerServerSrc} 
								alt="Server Viewer QR Code" 
								width={120} 
								height={120} 
								style={{ 
									border: '1px solid #e74c3c', 
									borderRadius: 8,
									marginBottom: 12
								}} 
							/>
						)}
						{/* Show loading state during SSR */}
						{!mounted && (
							<div style={{ 
								width: 120, 
								height: 120, 
								background: '#f8f9fa', 
								border: '1px solid #e74c3c', 
								borderRadius: 8,
								marginBottom: 12,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								fontSize: 10,
								color: '#7f8c8d'
							}}>
								Loading...
							</div>
						)}
						<div>
							<a 
								href={mounted ? viewerServerUrl : '#'}
								style={{
									display: 'inline-block',
									padding: '10px 20px',
									background: '#e74c3c',
									color: 'white',
									textDecoration: 'none',
									borderRadius: 6,
									fontWeight: 'bold',
									fontSize: 14,
									transition: 'background 0.2s'
								}}
								onMouseOver={(e) => e.currentTarget.style.background = '#c0392b'}
								onMouseOut={(e) => e.currentTarget.style.background = '#e74c3c'}
							>
								🚀 Open Server Viewer
							</a>
						</div>
					</div>
				</div>
			</div>

			{/* Troubleshooting Section */}
			<div style={{ 
				background: '#fff3cd', 
				padding: 20, 
				borderRadius: 8, 
				marginBottom: 24,
				border: '1px solid #ffeaa7'
			}}>
				<h3 style={{ margin: '0 0 16px 0', color: '#856404' }}>🔧 Troubleshooting</h3>
				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
					<div>
						<h4 style={{ color: '#856404', margin: '0 0 8px 0' }}>Phone Connection Issues</h4>
						<ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.5 }}>
							<li>Ensure phone and laptop are on same WiFi network</li>
							<li>Try using the direct URL instead of QR code</li>
							<li>Allow camera permissions in browser settings</li>
							<li>Use Chrome/Safari (latest version)</li>
						</ul>
					</div>
					<div>
						<h4 style={{ color: '#856404', margin: '0 0 8px 0' }}>Performance Issues</h4>
						<ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.5 }}>
							<li>Use WASM mode for low-resource devices</li>
							<li>Use Server mode for better performance</li>
							<li>Close other browser tabs/applications</li>
							<li>Check service status indicators above</li>
						</ul>
					</div>
				</div>
			</div>

			{/* Advanced Options */}
			<details style={{ 
				background: '#f8f9fa', 
				padding: 16, 
				borderRadius: 8,
				border: '1px solid #e9ecef'
			}}>
				<summary style={{ cursor: 'pointer', fontWeight: 'bold', color: '#495057' }}>
					⚙️ Advanced Options & Direct Links
				</summary>
				<div style={{ marginTop: 16 }}>
					<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
						<div>
							<h4 style={{ margin: '0 0 8px 0' }}>Direct Links</h4>
							<ul style={{ margin: 0, paddingLeft: 20 }}>
								<li><Link href="/sender">📱 Sender Page</Link></li>
								<li><Link href="/viewer">💻 Viewer Page</Link></li>
							</ul>
						</div>
						<div>
							<h4 style={{ margin: '0 0 8px 0' }}>Benchmark Tools</h4>
							<ul style={{ margin: 0, paddingLeft: 20 }}>
								<li>Run <code>run_bench.bat</code> for automated testing</li>
								<li>Use <code>--duration 60</code> for longer tests</li>
								<li>Check <code>metrics.json</code> for results</li>
							</ul>
						</div>
					</div>
				</div>
			</details>
		</div>
	);
}


