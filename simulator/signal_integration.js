// 信号模型集成 - 应用到 sendUplink 函数中
// 替换原有的 RSSI/SNR 计算逻辑

// 在原代码第1480行左右 (let rssi = rf.rssi ?? -42 之前) 添加:

      // ====== 真实信号模型集成 ======
      let rssi, lsnr, rssiStd;
      
      // 尝试使用真实信号模型
      if (config.signalModel && config.signalModel.enabled && lorawanDevice) {
        const deviceIndex = lorawanDevice._deviceIndex || 0;
        const totalDevices = lorawanDevice._totalDevices || 1;
        const signalResult = calculateRealisticSignal(
          deviceIndex,
          totalDevices,
          { frequency: chosenFreq * 1000000 },
          config,
          Date.now()
        );
        rssi = signalResult.rssi;
        lsnr = signalResult.snr;
        rssiStd = signalResult.rssiStd;
        
        // 保存到设备状态用于后续抖动计算
        if (lorawanDevice.nodeState) {
          lorawanDevice.nodeState.lastRssi = rssi;
          lorawanDevice.nodeState.lastSnr = lsnr;
        }
      } else {
        // 原有逻辑 (向后兼容)
        rssi = rf.rssi ?? -42;
        lsnr = rf.lsnr ?? 5.5;
        
        if (lorawanDevice && lorawanDevice.nodeState) {
          const ns = lorawanDevice.nodeState;
          const jitterR = (ns.rssiJitter !== undefined ? ns.rssiJitter : 1.5) * (2 * Math.random() - 1);
          const jitterS = (ns.snrJitter !== undefined ? ns.snrJitter : 0.8) * (2 * Math.random() - 1);
          let baseRssi = (ns.lastRssi !== undefined ? ns.lastRssi : ns.rssi) + jitterR;
          if (lorawanDevice.macParams && lorawanDevice.macParams.txPower !== undefined) {
            const currentDbm = TX_POWER_DBM_AS923[lorawanDevice.macParams.txPower] ?? 14;
            const initialDbm = TX_POWER_DBM_AS923[ns.txPowerIndex] ?? 14;
            baseRssi += (currentDbm - initialDbm);
          }
          rssi = clamp(baseRssi, -120, 10);
          lsnr = Math.max(-20, Math.min(10, (ns.lastSnr !== undefined ? ns.lastSnr : ns.snr) + jitterS));
          ns.lastRssi = rssi;
          ns.lastSnr = lsnr;
        }
      }
      // ====== 信号模型集成结束 ======
