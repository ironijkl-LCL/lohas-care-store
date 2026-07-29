const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// 初始化 Firebase Admin SDK
initializeApp();
const db = getFirestore();

/**
 * 安全創建訂單 Cloud Function
 * 部署地區設為香港 (asia-east1) 以降低延遲
 */
exports.createOrder = onCall({ region: "asia-east1" }, async (request) => {
  // 1. 身分驗證檢查（由 Firebase Auth 自動保證）
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "未經授權，請先登入會員帳號！");
  }
  
  const uid = request.auth.uid;
  const userEmail = request.auth.token.email || "";
  const { items, address, paymentMethod } = request.data;

  // 2. 輸入參數格式基本校驗
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError("invalid-argument", "購物車不可為空！");
  }
  
  if (!address || typeof address !== "string" || address.trim().length < 5 || address.length > 200) {
    throw new HttpsError("invalid-argument", "請提供有效的詳細送貨地址（5-200字）！");
  }

  const validPaymentMethods = ["PayMe", "AlipayHK", "FPS"];
  if (!validPaymentMethods.includes(paymentMethod)) {
    throw new HttpsError("invalid-argument", "不支援的支付渠道！");
  }

  // 3. 執行 Firestore 事務 (Transaction)
  try {
    const orderResult = await db.runTransaction(async (transaction) => {
      let calculatedTotal = 0;
      const verifiedOrderItems = [];
      const productUpdates = [];

      // A. 從數據庫撈取商品的真實單價與庫存（絕不信任前端傳入的 price）
      for (const item of items) {
        if (!item.id || !item.qty || typeof item.qty !== "number" || item.qty <= 0) {
          throw new HttpsError("invalid-argument", "購物車商品資料異常！");
        }

        const productRef = db.collection("products").doc(item.id);
        const productSnap = await transaction.get(productRef);

        if (!productSnap.exists) {
          throw new HttpsError("not-found", `商品 (ID: ${item.id}) 已下架或不存在！`);
        }

        const productData = productSnap.data();
        const realPrice = Number(productData.price) || 0;
        const currentStock = Number(productData.stock) || 0;

        // 庫存檢驗
        if (currentStock < item.qty) {
          throw new HttpsError(
            "resource-exhausted",
            `【${productData.name}】庫存不足，目前僅剩 ${currentStock} 件！`
          );
        }

        // 後端嚴格重算總金額
        calculatedTotal += realPrice * item.qty;

        verifiedOrderItems.push({
          id: item.id,
          name: productData.name || "未命名商品",
          price: realPrice,
          qty: item.qty
        });

        // 記錄要扣減的庫存
        productUpdates.push({
          ref: productRef,
          newStock: currentStock - item.qty
        });
      }

      // B. 讀取並計算會員權益 (積分/印花/等級)
      const userRef = db.collection("users").doc(uid);
      const userSnap = await transaction.get(userRef);

      let currentPoints = 0;
      let currentSpent = 0;
      let currentStamps = 0;

      if (userSnap.exists) {
        const uData = userSnap.data();
        currentPoints = Number(uData.points) || 0;
        currentSpent = Number(uData.totalSpent) || 0;
        currentStamps = Number(uData.stamps) || 0;
      }

      // 規則：每 $10 獲 1 積分，每 $200 獲 1 印花（上限 10 個）
      const earnedPoints = Math.floor(calculatedTotal / 10);
      const earnedStamps = Math.floor(calculatedTotal / 200);

      const newPoints = currentPoints + earnedPoints;
      const newSpent = currentSpent + calculatedTotal;
      let newStamps = currentStamps + earnedStamps;
      if (newStamps > 10) newStamps = 10;

      let newLevel = "普通會員";
      if (newSpent >= 5000) newLevel = "金級會員";
      else if (newSpent >= 1500) newLevel = "銀級會員";

      // C. 寫入變更：扣減庫存
      for (const updateItem of productUpdates) {
        transaction.update(updateItem.ref, { stock: updateItem.newStock });
      }

      // D. 寫入變更：更新用戶積分與消費紀錄
      transaction.set(
        userRef,
        {
          uid,
          email: userEmail,
          points: newPoints,
          totalSpent: newSpent,
          stamps: newStamps,
          level: newLevel,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // E. 寫入變更：生成正式訂單 Document
      const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const generatedOrderId = `LOHAS-${datePrefix}-${randomSuffix}`;
      const orderRef = db.collection("orders").doc(generatedOrderId);

      transaction.set(orderRef, {
        orderId: generatedOrderId,
        uid,
        items: verifiedOrderItems,
        totalAmount: calculatedTotal,
        paymentMethod,
        address: address.trim(),
        status: "pending_verification", // 待核對過數紙
        receiptUrl: "",
        createdAt: FieldValue.serverTimestamp()
      });

      return {
        orderId: generatedOrderId,
        totalAmount: calculatedTotal,
        earnedPoints,
        earnedStamps
      };
    });

    return {
      success: true,
      data: orderResult
    };
  } catch (error) {
    console.error("訂單創建失敗:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", `系統處理訂單時發生錯誤: ${error.message}`);
  }
});
