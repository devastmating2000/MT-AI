//+------------------------------------------------------------------+
//| MTAI_Bridge.mq5                                                  |
//| Links a MetaTrader 5 terminal to the MT-AI agent server.         |
//|                                                                  |
//| Once a second it POSTs quotes, closed bars, positions and order  |
//| results to the server, and executes the commands that come back. |
//|                                                                  |
//| Setup: Tools > Options > Expert Advisors > "Allow WebRequest for |
//| listed URL" and add the server address (http://127.0.0.1:8787).  |
//+------------------------------------------------------------------+
#property copyright "MT-AI"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

input string          InpServerUrl      = "http://127.0.0.1:8787/bridge/sync"; // Server URL
input string          InpToken          = "";                                  // Token (same as MTAI_BRIDGE_TOKEN)
input string          InpSymbols        = "EURUSD,GBPUSD,USDJPY,XAUUSD,XAGUSD"; // Symbols, without broker suffix
input string          InpSuffix         = "";                                  // Broker suffix, e.g. -STD or -ECN
input ENUM_TIMEFRAMES InpTimeframe      = PERIOD_M15;                          // Timeframe
input long            InpMagic          = 20260;                               // Magic number
input int             InpPollMs         = 1000;                                // Poll interval (ms)
input int             InpSlippagePoints = 20;                                  // Max slippage (points)

CTrade   g_trade;
string   g_symbols[];
datetime g_lastBar[];
int      g_histWanted[];
string   g_outbox    = "";
bool     g_sendSpecs = true;
bool     g_warned    = false;

string BrokerSymbol(const string symbol) { return symbol + InpSuffix; }

string PlainSymbol(const string symbol)
  {
   int n = StringLen(InpSuffix);
   int len = StringLen(symbol);
   if(n > 0 && len > n && StringSubstr(symbol, len - n) == InpSuffix)
      return StringSubstr(symbol, 0, len - n);
   return symbol;
  }

// Bar and tick times are in broker server time; the agents work in UTC.
long ServerOffset()
  {
   double diff = (double)(TimeTradeServer() - TimeGMT());
   return (long)MathRound(diff / 1800.0) * 1800;
  }

int OnInit()
  {
   if(StringLen(InpToken) < 16)
     {
      Alert("MTAI: defina InpToken (16 ou mais caracteres, igual a MTAI_BRIDGE_TOKEN).");
      return INIT_PARAMETERS_INCORRECT;
     }
   int n = StringSplit(InpSymbols, ',', g_symbols);
   ArrayResize(g_lastBar, n);
   ArrayResize(g_histWanted, n);
   for(int i = 0; i < n; i++)
     {
      StringTrimLeft(g_symbols[i]);
      StringTrimRight(g_symbols[i]);
      g_lastBar[i] = 0;
      g_histWanted[i] = 0;
      if(!SymbolSelect(BrokerSymbol(g_symbols[i]), true))
         Print("MTAI: símbolo não encontrado: ", BrokerSymbol(g_symbols[i]), " (verifique InpSuffix)");
     }
   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePoints);
   EventSetMillisecondTimer(MathMax(250, InpPollMs));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer() { Sync(); }

string Num(const double v, const int digits = 8) { return DoubleToString(v, digits); }

string BarLine(const string tag, const string symbol, const MqlRates &r, const long offset)
  {
   return tag + "|" + symbol + "|" + IntegerToString((long)r.time - offset) + "|" + Num(r.open) + "|" + Num(r.high) + "|"
          + Num(r.low) + "|" + Num(r.close) + "|" + IntegerToString(r.tick_volume) + "\n";
  }

string BuildBody()
  {
   long offset = ServerOffset();
   string body = "ACCOUNT|" + Num(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "|" + Num(AccountInfoDouble(ACCOUNT_EQUITY), 2)
                 + "|" + AccountInfoString(ACCOUNT_CURRENCY) + "\n";

   for(int i = 0; i < ArraySize(g_symbols); i++)
     {
      string s  = g_symbols[i];
      string bs = BrokerSymbol(s);

      if(g_sendSpecs)
         body += "SPEC|" + s + "|" + IntegerToString(SymbolInfoInteger(bs, SYMBOL_DIGITS)) + "|" + Num(SymbolInfoDouble(bs, SYMBOL_POINT))
                 + "|" + Num(SymbolInfoDouble(bs, SYMBOL_TRADE_CONTRACT_SIZE), 2) + "|" + Num(SymbolInfoDouble(bs, SYMBOL_VOLUME_MIN), 2)
                 + "|" + Num(SymbolInfoDouble(bs, SYMBOL_VOLUME_STEP), 2) + "|" + Num(SymbolInfoDouble(bs, SYMBOL_TRADE_TICK_VALUE))
                 + "|" + Num(SymbolInfoDouble(bs, SYMBOL_TRADE_TICK_SIZE)) + "\n";

      MqlTick tick;
      if(SymbolInfoTick(bs, tick))
         body += "TICK|" + s + "|" + Num(tick.bid) + "|" + Num(tick.ask) + "|" + IntegerToString((long)tick.time - offset) + "\n";

      if(g_histWanted[i] > 0)
        {
         MqlRates rates[];
         int got = CopyRates(bs, InpTimeframe, 1, g_histWanted[i], rates);
         if(got > 0)
           {
            for(int k = 0; k < got; k++)
               body += BarLine("HIST", s, rates[k], offset);
            g_lastBar[i] = rates[got - 1].time;
            g_histWanted[i] = 0;
           }
         continue;
        }

      datetime closed = iTime(bs, InpTimeframe, 1);
      if(closed > 0 && closed != g_lastBar[i])
        {
         MqlRates one[];
         if(g_lastBar[i] != 0 && CopyRates(bs, InpTimeframe, 1, 1, one) == 1)
            body += BarLine("BAR", s, one[0], offset);
         g_lastBar[i] = closed;
        }
     }

   string lines = "";
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;
      bool buy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      lines += "POS|" + IntegerToString(PositionGetInteger(POSITION_IDENTIFIER)) + "|" + PlainSymbol(PositionGetString(POSITION_SYMBOL))
               + "|" + (buy ? "BUY" : "SELL") + "|" + Num(PositionGetDouble(POSITION_VOLUME), 2) + "|" + Num(PositionGetDouble(POSITION_PRICE_OPEN))
               + "|" + Num(PositionGetDouble(POSITION_SL)) + "|" + Num(PositionGetDouble(POSITION_TP))
               + "|" + Num(PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP), 2)
               + "|" + IntegerToString((long)PositionGetInteger(POSITION_TIME) - offset) + "\n";
      count++;
     }
   body += "POSITIONS|" + IntegerToString(count) + "\n" + lines;
   return body + g_outbox;
  }

void Sync()
  {
   string body = BuildBody();
   char data[];
   int len = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0)
      ArrayResize(data, len - 1); // drop the terminating zero

   char result[];
   string responseHeaders;
   string headers = "Content-Type: text/plain\r\nX-MTAI-Token: " + InpToken + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", InpServerUrl, headers, 5000, data, result, responseHeaders);
   if(code != 200)
     {
      if(!g_warned)
        {
         if(code == -1)
            Print("MTAI: WebRequest falhou (erro ", GetLastError(), "). Adicione o URL do servidor em Ferramentas > Opções > Expert Advisors.");
         else
            Print("MTAI: o servidor respondeu ", code, ". Verifique o token e se o servidor está em modo mt5.");
         g_warned = true;
        }
      return;
     }
   g_warned    = false;
   g_sendSpecs = false;
   g_outbox    = ""; // delivered

   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   string lines[];
   int n = StringSplit(response, '\n', lines);
   for(int i = 0; i < n; i++)
     {
      string f[];
      int parts = StringSplit(lines[i], '|', f);
      if(parts < 2)
         continue;
      if(f[0] == "HISTORY" && parts >= 3)
         WantHistory(f[1], (int)StringToInteger(f[2]));
      else if(f[0] == "OPEN" && parts >= 7)
         OpenPosition(f[1], f[2], f[3], StringToDouble(f[4]), StringToDouble(f[5]), StringToDouble(f[6]), parts >= 8 ? f[7] : "MTAI");
      else if(f[0] == "CLOSE" && parts >= 3)
         ClosePosition(f[1], StringToInteger(f[2]));
     }
  }

void WantHistory(const string symbol, const int bars)
  {
   for(int i = 0; i < ArraySize(g_symbols); i++)
      if(g_symbols[i] == symbol)
         g_histWanted[i] = MathMax(1, MathMin(bars, 5000));
  }

double NormalizeVolume(const string bs, const double lots)
  {
   double step = SymbolInfoDouble(bs, SYMBOL_VOLUME_STEP);
   double minv = SymbolInfoDouble(bs, SYMBOL_VOLUME_MIN);
   double maxv = SymbolInfoDouble(bs, SYMBOL_VOLUME_MAX);
   if(step <= 0)
      step = 0.01;
   double v = MathFloor(lots / step + 0.0000001) * step;
   if(v < minv)
      return 0;
   return NormalizeDouble(MathMin(v, maxv), 2);
  }

void Fail(const string id, const string message)
  {
   string clean = message;
   StringReplace(clean, "|", " ");
   StringReplace(clean, "\n", " ");
   g_outbox += "RESULT|" + id + "|ERR|0|0|" + clean + "\n";
  }

void OpenPosition(const string id, const string symbol, const string side, const double lots, const double sl, const double tp, const string comment)
  {
   string bs = BrokerSymbol(symbol);
   int digits = (int)SymbolInfoInteger(bs, SYMBOL_DIGITS);
   double volume = NormalizeVolume(bs, lots);
   if(volume <= 0)
     {
      Fail(id, "volume abaixo do mínimo do corretor");
      return;
     }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
     {
      Fail(id, "Algo Trading desligado no terminal");
      return;
     }
   g_trade.SetTypeFillingBySymbol(bs);
   double nsl = NormalizeDouble(sl, digits);
   double ntp = NormalizeDouble(tp, digits);
   bool sent = (side == "BUY") ? g_trade.Buy(volume, bs, 0.0, nsl, ntp, comment) : g_trade.Sell(volume, bs, 0.0, nsl, ntp, comment);
   uint rc = g_trade.ResultRetcode();
   if(!sent || (rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_DONE_PARTIAL && rc != TRADE_RETCODE_PLACED))
     {
      Fail(id, g_trade.ResultRetcodeDescription() + " (" + IntegerToString(rc) + ")");
      return;
     }
   long   position = (long)g_trade.ResultOrder();
   double price    = g_trade.ResultPrice();
   if(PositionSelectByTicket(g_trade.ResultOrder()))
     {
      position = PositionGetInteger(POSITION_IDENTIFIER);
      if(price <= 0)
         price = PositionGetDouble(POSITION_PRICE_OPEN);
     }
   g_outbox += "RESULT|" + id + "|OK|" + IntegerToString(position) + "|" + Num(price) + "\n";
  }

void ClosePosition(const string id, const long identifier)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || PositionGetInteger(POSITION_MAGIC) != InpMagic || PositionGetInteger(POSITION_IDENTIFIER) != identifier)
         continue;
      g_trade.SetTypeFillingBySymbol(PositionGetString(POSITION_SYMBOL));
      if(g_trade.PositionClose(ticket))
         g_outbox += "RESULT|" + id + "|OK|" + IntegerToString(identifier) + "|" + Num(g_trade.ResultPrice()) + "\n";
      else
         Fail(id, g_trade.ResultRetcodeDescription());
      return;
     }
   Fail(id, "posição não encontrada");
  }

// Report every deal that closes a position, including stops and targets hit on the broker side.
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD || !HistoryDealSelect(trans.deal))
      return;
   long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY)
      return;
   long reason = HistoryDealGetInteger(trans.deal, DEAL_REASON);
   string why = "OTHER";
   if(reason == DEAL_REASON_SL)
      why = "SL";
   else if(reason == DEAL_REASON_TP)
      why = "TP";
   else if(reason == DEAL_REASON_CLIENT || reason == DEAL_REASON_MOBILE || reason == DEAL_REASON_WEB || reason == DEAL_REASON_EXPERT)
      why = "MANUAL";
   double profit = HistoryDealGetDouble(trans.deal, DEAL_PROFIT) + HistoryDealGetDouble(trans.deal, DEAL_SWAP)
                   + HistoryDealGetDouble(trans.deal, DEAL_COMMISSION);
   // The server ignores deals for positions it did not open, so no magic filter is needed here.
   g_outbox += "DEAL|" + IntegerToString(HistoryDealGetInteger(trans.deal, DEAL_POSITION_ID)) + "|"
               + PlainSymbol(HistoryDealGetString(trans.deal, DEAL_SYMBOL)) + "|" + Num(profit, 2) + "|"
               + Num(HistoryDealGetDouble(trans.deal, DEAL_PRICE)) + "|"
               + IntegerToString((long)HistoryDealGetInteger(trans.deal, DEAL_TIME) - ServerOffset()) + "|" + why + "\n";
  }
//+------------------------------------------------------------------+
