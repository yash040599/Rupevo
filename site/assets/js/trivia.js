// "Did you know?" cards: short stories from market history, each with a takeaway, and facts about
// Indian tax for RSU holders. Shown on the tax pages (both kinds) and on the home and ranking pages
// (market stories). Data and helpers are unit-tested in tests/js/trivia.test.mjs.
//
// Adding a story: keep it true and checkable (dates, numbers, names), under about 450 characters,
// with a takeaway an ordinary investor can use. No tips on particular stocks.
import { dayIndexOf, financialYear, istWallClock } from './fy.js';

export const TRIVIA_TAGS = ['World', 'India', 'Quick maths', 'Tax'];

// Ordered so that consecutive stories change place and era.
export const MARKET_STORIES = [
  {
    id: 'tulips', tag: 'World', year: '1637', title: 'Tulip mania',
    story: 'In the Dutch Republic in the winter of 1636–37, contracts for rare tulip bulbs changed hands for more '
      + 'than the price of a canal house in Amsterdam. In February 1637 buyers stopped turning up and prices '
      + 'collapsed within days. (Historians now think fewer people were ruined than the legend says.)',
    takeaway: 'When people buy something only because its price keeps rising, the price can fall just as fast. '
      + 'Ask what it is worth to someone who has to hold it.',
  },
  {
    id: 'bse-banyan', tag: 'India', year: '1875', title: 'Dalal Street means Broker Street',
    story: 'In the 1850s a handful of Bombay brokers traded shares under a banyan tree near Town Hall. As their '
      + 'numbers grew they moved to what became Dalal Street (‘dalal’ means broker), and in 1875 they formed '
      + 'the association that became the Bombay Stock Exchange, Asia’s oldest.',
    takeaway: 'India’s market has kept going for 150 years through wars, scams and crashes. Patient owners have '
      + 'done far better than people trying to dodge every fall.',
  },
  {
    id: 'rule-72', tag: 'Quick maths', title: 'The rule of 72',
    story: 'Divide 72 by a yearly return to see roughly how many years money takes to double: about 6 years at '
      + '12%, 9 years at 8%. With 7% inflation, prices double in about 10 years.',
    takeaway: 'Small differences in return compound into big differences over decades — and so does inflation, '
      + 'which is why cash left idle slowly shrinks.',
  },
  {
    id: 'black-monday', tag: 'World', year: '1987', title: 'The worst day, then a positive year',
    story: 'On 19 October 1987, ‘Black Monday’, the Dow Jones fell 22.6% in a single day, still its worst day ever. '
      + 'Yet the index finished 1987 slightly higher than it began.',
    takeaway: 'Even the worst day in history was a blip for patient investors. Panic-selling turns a temporary '
      + 'fall into a permanent loss.',
  },
  {
    id: 'harshad', tag: 'India', year: '1992', title: 'The Big Bull',
    story: 'Between April 1991 and April 1992 the Sensex roughly quadrupled, driven partly by broker Harshad '
      + 'Mehta, who bought shares with money diverted from the banking system through fake bank receipts. '
      + 'When journalist Sucheta Dalal exposed the scam in April 1992, the market crashed.',
    takeaway: 'When prices rise far faster than profits, ask where the money is coming from. The scandal sped up '
      + 'reforms such as screen-based trading at the new NSE and electronic (demat) shares.',
  },
  {
    id: 'mizuho', tag: 'World', year: '2005', title: 'The ¥40 billion typo',
    story: 'In December 2005 a trader at Mizuho Securities meant to sell one share of J-Com at ¥610,000 but '
      + 'typed an order to sell 610,000 shares at ¥1, far more shares than the company had. The order could not '
      + 'be cancelled in time, and the slip cost Mizuho about ¥40 billion (around $340 million).',
    takeaway: 'Check the quantity and price before you press the button. A limit order caps the price you will '
      + 'accept.',
  },
  {
    id: 'mrf', tag: 'India', year: '2023', title: '₹1 lakh a share',
    story: 'In June 2023 MRF became the first Indian share to cross ₹1,00,000. It is that high because the company '
      + 'has never split its shares, not because it is India’s most valuable company. Berkshire Hathaway’s '
      + 'never-split Class A shares cost hundreds of thousands of dollars each.',
    takeaway: 'A share’s price alone says nothing about cheap or expensive. Compare a company’s value with its '
      + 'earnings (the P/E), not the number on the screen.',
  },
  {
    id: 'enron', tag: 'World', year: '2001', title: 'America’s most innovative company',
    story: 'Fortune named Enron ‘America’s Most Innovative Company’ six years in a row. In December 2001 it went '
      + 'bankrupt after an accounting fraud. Many employees held their retirement savings in Enron shares and '
      + 'lost their jobs and their savings at the same time.',
    takeaway: 'Your salary already depends on your employer. Keeping most of your savings in its shares, RSUs '
      + 'included, doubles that bet: spread it out.',
  },
  {
    id: 'covid-2020', tag: 'India', year: '2020', title: 'Down 38%, then a record',
    story: 'On 23 March 2020, as the Covid lockdown began, the Sensex fell 13% in a day, its worst fall ever. The '
      + 'Nifty had dropped about 38% in two months. By November 2020 it was at a new record high.',
    takeaway: 'Crashes feel endless while they happen, but recoveries can be swift. Selling in panic locks in the '
      + 'fall; SIPs that carried on bought units cheaply.',
  },
  {
    id: 'newton', tag: 'World', year: '1720', title: 'Isaac Newton and the South Sea Bubble',
    story: 'Isaac Newton made money on South Sea Company shares in 1720, sold, then bought back in near the top as '
      + 'the frenzy went on. He reportedly lost about £20,000, a fortune then, and is said to have remarked that '
      + 'he could calculate the motions of the heavens but not the madness of people.',
    takeaway: 'Being clever doesn’t protect you from the crowd. Decide your plan before prices start racing, and '
      + 'stick to it.',
  },
  {
    id: 'infosys-ipo', tag: 'India', year: '1993', title: 'The IPO nobody wanted',
    story: 'Infosys’s 1993 IPO, at ₹95 a share, was undersubscribed: Morgan Stanley stepped in and took 13% of the '
      + 'company at the issue price. Infosys went on to become one of the biggest wealth creators on Indian '
      + 'markets.',
    takeaway: 'The market’s first reaction isn’t the final verdict. A lukewarm start says little about a '
      + 'business’s next 30 years.',
  },
  {
    id: 'fees', tag: 'Quick maths', title: 'The 1% that eats a quarter',
    story: 'A 1% yearly fee sounds tiny. But on money growing at 10% a year, it takes about a quarter of the final '
      + 'amount after 30 years.',
    takeaway: 'Compare expense ratios. Direct plans of mutual funds cost less than regular plans because they '
      + 'pay no distributor commission.',
  },
  {
    id: 'templeton', tag: 'World', year: '1939', title: 'Buying everything under a dollar',
    story: 'In 1939, as war broke out in Europe, 26-year-old John Templeton borrowed $10,000 and bought 100 shares '
      + 'of every US stock trading below $1: 104 companies, 34 of them in or near bankruptcy. Only four ended up '
      + 'worthless, and four years later he sold for about $40,000.',
    takeaway: 'Bargains appear when the news is worst. Spreading the bet across 104 companies is what let him '
      + 'survive the ones that failed.',
  },
  {
    id: 'satyam', tag: 'India', year: '2009', title: 'Riding a tiger',
    story: 'In January 2009 the chairman of Satyam Computer Services, then India’s fourth-largest IT company, '
      + 'confessed in a letter that its profits had been inflated for years and that over ₹5,000 crore of reported '
      + 'cash did not exist. ‘It was like riding a tiger,’ he wrote. The share fell nearly 80% that day.',
    takeaway: 'Profits on paper are easier to fake than cash. Check that a company’s reported profits turn into '
      + 'cash flow over the years.',
  },
  {
    id: 'zoom-ticker', tag: 'World', year: '2020', title: 'The wrong Zoom',
    story: 'In early 2020 investors piled into a tiny company with the ticker ZOOM, mistaking it for Zoom Video '
      + 'Communications (ticker ZM). Its shares soared until the US regulator suspended trading. In 2021 a tweet '
      + 'urging people to ‘use Signal’ sent an unrelated firm, Signal Advance, up more than tenfold.',
    takeaway: 'Check the full company name and exchange, not just the ticker, before you place an order.',
  },
  {
    id: 'cotton-1865', tag: 'India', year: '1865', title: 'Bombay’s cotton bubble',
    story: 'When the American Civil War cut off US cotton, mills in Britain turned to India and money poured into '
      + 'Bombay. Shares of the Back Bay Reclamation Company, issued at ₹5,000, traded at up to ₹53,000. When the '
      + 'war ended in 1865 prices collapsed, and the old Bank of Bombay, which had lent against shares, failed '
      + 'in 1866.',
    takeaway: 'Booms built on a temporary windfall end when the windfall does. Ask whether the profits you are '
      + 'paying for will last.',
  },
  {
    id: 'bogle', tag: 'World', year: '1976', title: 'Bogle’s Folly',
    story: 'In 1976 John Bogle launched the first index fund for ordinary investors: it simply owned the S&P 500. '
      + 'Critics called it ‘Bogle’s Folly’, and it raised about $11 million of the $150 million hoped for. Index '
      + 'funds now hold trillions of dollars.',
    takeaway: 'Costs compound just like returns. A cheap fund that owns the whole market beats most expensive '
      + 'ones over the long run.',
  },
  {
    id: 'may-2009', tag: 'India', year: '2009', title: 'Two upper circuits in one day',
    story: 'On 18 May 2009, after the general election results, the Sensex jumped 17%, its biggest one-day gain '
      + 'ever. Trading was halted within seconds of the open, and again within seconds of reopening, this time '
      + 'for the rest of the day.',
    takeaway: 'Some of the best days come soon after the worst. Many who sold during the 2008 crash missed this '
      + 'one.',
  },
  {
    id: 'apple-wayne', tag: 'World', year: '1976', title: 'The $800 Apple stake',
    story: 'Ronald Wayne co-founded Apple with Steve Jobs and Steve Wozniak in 1976 and sold his 10% stake back '
      + 'within two weeks for $800. That stake would later be worth hundreds of billions of dollars. He has said '
      + 'he does not regret it.',
    takeaway: 'Nobody can spot tomorrow’s giants reliably. Owning a broad index means you own the next Apple '
      + 'automatically, whoever it turns out to be.',
  },
  {
    id: 'paper-shares', tag: 'India', year: '2019', title: 'Old share certificates at home?',
    story: 'Since April 2019, shares held as paper certificates cannot be transferred until they are converted '
      + 'into demat form. And shares whose dividends go unclaimed for seven years in a row are moved to the '
      + 'government’s Investor Education and Protection Fund (IEPF).',
    takeaway: 'Found old certificates in a cupboard? Dematerialise them through a broker or the company’s '
      + 'registrar, and claim anything moved to the IEPF with Form IEPF-5.',
  },
  {
    id: 'ltcm', tag: 'World', year: '1998', title: 'Nobel prizes and a bailout',
    story: 'Long-Term Capital Management, a hedge fund whose partners included two Nobel prize-winning '
      + 'economists, lost about $4.6 billion in a few months of 1998. The US Federal Reserve organised a $3.6 '
      + 'billion rescue by banks to stop the damage spreading.',
    takeaway: 'Borrowed money turns small mistakes into fatal ones. A model is only as good as its assumptions '
      + 'about rare events.',
  },
  {
    id: 'reliance-1977', tag: 'India', year: '1977', title: 'Shareholder meetings in football grounds',
    story: 'Reliance’s 1977 public issue, at ₹10 a share with no premium, drew about 58,000 investors, many buying '
      + 'shares for the first time. By the mid-1980s its annual meetings had outgrown halls and were held at '
      + 'Mumbai’s Cooperage Football Ground and Cross Maidan, with thousands of shareholders attending.',
    takeaway: 'Shareholders are owners: you can attend annual meetings, vote on resolutions and ask questions — '
      + 'today mostly online.',
  },
  {
    id: 'best-days', tag: 'World', year: '2003–2022', title: 'Missing the best days',
    story: 'J.P. Morgan calculated that $10,000 kept in the S&P 500 from 2003 to 2022 grew to about $65,000. '
      + 'Missing just the 10 best days cut that to about $30,000, and seven of those best days came within two '
      + 'weeks of the worst ones.',
    takeaway: 'The best and worst days cluster together, so jumping out after a bad day often means missing the '
      + 'rebound. Staying invested is a strategy too.',
  },
  {
    id: 'nse-2012', tag: 'India', year: '2012', title: 'Fifteen per cent in seconds',
    story: 'On 5 October 2012, erroneous orders worth about ₹650 crore from one brokerage’s terminal sent the '
      + 'Nifty down about 15% in seconds. Trading was halted for 15 minutes, and prices recovered most of the '
      + 'fall the same day.',
    takeaway: 'In a sudden crash, market orders fill at whatever price is there. Limit orders and a moment’s '
      + 'patience protect you.',
  },
  {
    id: 'amazon-2001', tag: 'World', year: '1999–2009', title: 'A great company, a terrible stock — for a while',
    story: 'Amazon’s shares fell about 94% between December 1999 and September 2001 in the dot-com crash. Someone '
      + 'who bought at the 1999 peak waited about a decade to break even, and then watched it become one of the '
      + 'best-performing stocks in history.',
    takeaway: 'A great business can be a poor investment for years if you overpay. The price you pay matters as '
      + 'much as the company.',
  },
  {
    id: 'sensex-name', tag: 'India', year: '1989', title: 'Sensex and Nifty',
    story: 'The word ‘Sensex’ (sensitive index) was coined in 1989 by stock-market analyst Deepak Mohoni; the '
      + 'index starts from 100 in 1978-79. ‘Nifty’ joins ‘National’ and ‘fifty’. The Sensex crossed 80,000 in '
      + 'July 2024.',
    takeaway: 'From 100 to 80,000 is roughly 15–16% a year for 45 years, before dividends. Compounding needs time '
      + 'more than brilliance.',
  },
  {
    id: 'buffett-berkshire', tag: 'World', year: '1964–65', title: 'Buffett’s $200 billion grudge',
    story: 'Warren Buffett has called Berkshire Hathaway ‘the dumbest stock I ever bought’. In 1964 the struggling '
      + 'textile mill’s boss tried to shave the price he had agreed to pay for Buffett’s shares. Irritated, Buffett '
      + 'bought control of the company in 1965 instead, and later estimated that tying money up in textiles cost '
      + 'him about $200 billion.',
    takeaway: 'Anger, pride and the urge to get even are expensive. Make money decisions when you are calm.',
  },
  {
    id: 'muhurat', tag: 'India', year: 'Every Diwali', title: 'Muhurat trading',
    story: 'Every Diwali the NSE and BSE hold a special one-hour ‘Muhurat trading’ session to mark the start of '
      + 'the new Samvat year. Many families buy a token share for good luck.',
    takeaway: 'Traditions are fun, but returns come from businesses growing over years, not from the day you buy.',
  },
  {
    id: 'gamestop', tag: 'World', year: '2021', title: 'The Reddit squeeze',
    story: 'In January 2021 traders on Reddit’s WallStreetBets drove GameStop from under $20 to an intraday high of '
      + '$483 in a few weeks, inflicting billions of dollars of losses on funds that had bet on a fall. Within '
      + 'weeks it had fallen back by more than 80%.',
    takeaway: 'Crowds can push a price far from what a business earns, in both directions. Latecomers to a '
      + 'frenzy usually pay for it.',
  },
  {
    id: 'tata-1907', tag: 'India', year: '1907', title: '8,000 Indians fund a steel plant',
    story: 'When the Tata Iron and Steel Company raised money in 1907, London financiers held back. About 8,000 '
      + 'Indian investors subscribed the ₹2.3 crore issue instead, within three weeks.',
    takeaway: 'Public markets let ordinary savers own a slice of big enterprises. A broad index fund is the '
      + 'modern version of those 8,000 subscribers.',
  },
  {
    id: 'nikkei', tag: 'World', year: '1989–2024', title: 'A 34-year wait',
    story: 'Japan’s Nikkei 225 closed 1989 at 38,916. It did not close above that level again until February '
      + '2024, more than 34 years later.',
    takeaway: 'Paying sky-high prices can mean decades of waiting. Investing gradually, as a SIP does, and across '
      + 'countries reduces that risk.',
  },
  {
    id: 'reliance-power', tag: 'India', year: '2008 · 2021', title: 'Hype is not a return',
    story: 'Reliance Power’s January 2008 IPO was oversubscribed about 70 times, yet the share closed its first '
      + 'day below the ₹450 issue price. In November 2021 Paytm, then India’s largest IPO, fell 27% on its first '
      + 'day.',
    takeaway: 'Oversubscription measures demand for the shares, not the quality of the business. Read the '
      + 'prospectus, not the headlines.',
  },
  {
    id: 'madoff', tag: 'World', year: '1920 · 2008', title: 'Too smooth to be true',
    story: 'In 1920 Charles Ponzi promised 50% returns in 45 days, paying early investors with money from new ones. '
      + 'Bernie Madoff ran the same trick for decades, reporting a steady 10–12% a year in good markets and bad, '
      + 'until it collapsed in 2008 with about $65 billion in paper losses.',
    takeaway: 'Returns that are unusually high or unusually smooth, with a vague strategy, are red flags. In '
      + 'India, check that an adviser or scheme is registered with SEBI.',
  },
  {
    id: 't-plus-1', tag: 'India', year: '2023', title: 'Next-day money',
    story: 'India completed its move to T+1 settlement in January 2023: when you sell shares, the money arrives the '
      + 'next working day. The US made the same move only in May 2024.',
    takeaway: 'You can raise cash from shares within a day, but not instantly, and never at a guaranteed price: '
      + 'money you need this month belongs in the bank.',
  },
  {
    id: 'vw-squeeze', tag: 'World', year: '2008', title: 'The world’s most valuable company, briefly',
    story: 'In October 2008, in the middle of the financial crisis, Volkswagen briefly became the world’s most '
      + 'valuable company. Porsche had revealed it controlled about 74% of VW, leaving few shares for traders who '
      + 'had bet on a fall, and they scrambled to buy them back.',
    takeaway: 'Betting on a fall (short selling) has unlimited risk: a price can only fall to zero, but it can '
      + 'rise without limit.',
  },
  {
    id: 'jhunjhunwala', tag: 'India', year: '1985', title: '₹5,000 and patience',
    story: 'Rakesh Jhunjhunwala started investing in 1985 with about ₹5,000. His best-known holding, Titan, was '
      + 'bought mostly in the early 2000s at a few rupees a share (adjusted for splits) and held for about two '
      + 'decades as it grew into a household name.',
    takeaway: 'Wealth in shares usually comes from holding good businesses for a long time, not from frequent '
      + 'trading.',
  },
  {
    id: 'buttonwood', tag: 'World', year: '1792', title: 'Born under a tree',
    story: 'On 17 May 1792, 24 brokers signed a two-sentence agreement, by tradition under a buttonwood tree on '
      + 'Wall Street, to trade only with each other at a fixed commission. That pact grew into the New York '
      + 'Stock Exchange.',
    takeaway: 'Markets run on trust and rules. The ‘boring’ parts — exchanges, regulators, clearing — are what '
      + 'let strangers trade safely.',
  },
  {
    id: 'kodak', tag: 'World', year: '1975–2012', title: 'The camera Kodak shelved',
    story: 'A Kodak engineer, Steve Sasson, built the first digital camera in 1975. Kodak, earning a fortune from '
      + 'film, was slow to embrace it, and filed for bankruptcy in 2012.',
    takeaway: 'Today’s leaders are not tomorrow’s by default. That is why indices like the Nifty keep replacing '
      + 'members, and why owning the whole index is easier than picking survivors.',
  },
  {
    id: 'coca-cola', tag: 'World', year: '1988–2024', title: '60% a year on cost',
    story: 'Berkshire Hathaway bought its Coca-Cola shares between 1988 and 1994 for $1.3 billion and has not added '
      + 'a share since. In 2024 those shares paid it about $776 million in dividends: roughly 60% of the '
      + 'original cost, in a single year.',
    takeaway: 'Dividends that keep growing on a fixed cost compound quietly. Patience turns a modest yield into a '
      + 'large one on what you paid.',
  },
  {
    id: 'shoeshine', tag: 'World', year: '1929', title: 'The shoeshine boy',
    story: 'The story goes that Joseph Kennedy, father of President John F. Kennedy, decided to get out of the '
      + 'stock market in 1929 when a shoeshine boy started giving him stock tips. Months later came the Great '
      + 'Crash.',
    takeaway: 'When everyone around you has a hot tip, the optimism is probably already in the price. '
      + 'Excitement is not a strategy.',
  },
  {
    id: 'lehman', tag: 'World', year: '2008', title: '158 years, then gone',
    story: 'Lehman Brothers, founded in 1850, filed for bankruptcy on 15 September 2008. With over $600 billion of '
      + 'assets, it is still the largest bankruptcy in US history.',
    takeaway: '‘Too big to fail’ is not a promise. No single company, however old or famous, deserves all your '
      + 'money.',
  },
  {
    id: 'knight', tag: 'World', year: '2012', title: '$440 million in 45 minutes',
    story: 'On 1 August 2012 a botched software update made Knight Capital’s trading system fire off millions of '
      + 'unintended orders. In about 45 minutes the firm lost $440 million, far more than it earned in a year, '
      + 'and it had to be rescued.',
    takeaway: 'Automation is powerful, but check what runs on autopilot now and then: SIP mandates, auto-renewals '
      + 'and standing instructions included.',
  },
  {
    id: 'voc', tag: 'World', year: '1602', title: 'The first share',
    story: 'The Dutch East India Company (VOC), founded in 1602, issued the first shares that anyone could buy '
      + 'and sell on an exchange, in Amsterdam. For a time it was the world’s most powerful company. It was '
      + 'dissolved in 1799.',
    takeaway: 'Even the mightiest company of its era did not last for ever. Spreading your money across many '
      + 'businesses is insurance against the unknowable.',
  },
  {
    id: 'mr-market', tag: 'World', year: '1949', title: 'Meet Mr. Market',
    story: 'In The Intelligent Investor (1949), Benjamin Graham described ‘Mr. Market’, a moody partner who offers '
      + 'every day to buy your share of a business or sell you his, at prices that swing with his mood. You are '
      + 'free to ignore him.',
    takeaway: 'Daily prices are offers, not instructions. Use them when they suit you; you don’t have to react to '
      + 'every mood swing.',
  },
  {
    id: 'buffett-bet', tag: 'World', year: '2008–2017', title: 'Buffett’s million-dollar bet',
    story: 'Warren Buffett bet $1 million that an S&P 500 index fund would beat a hand-picked group of hedge funds '
      + 'over ten years. From 2008 to 2017 the index fund returned about 7.1% a year and the funds about 2.2%. '
      + 'Buffett won, and the money went to charity.',
    takeaway: 'Fees and frequent trading eat returns quietly. Over ten years, expensive expert management lost to '
      + 'doing almost nothing.',
  },
  {
    id: 'bears', tag: 'World', year: '1700s', title: 'Why bears and bulls?',
    story: '‘Bear’ probably comes from an 18th-century proverb about selling the bear’s skin before catching the '
      + 'bear: ‘bearskin jobbers’ sold shares they did not own, hoping to buy them back cheaper. ‘Bull’ followed '
      + 'as its opposite.',
    takeaway: 'Markets need both optimists and sceptics; a price is simply where they meet.',
  },
  {
    id: 'pizza', tag: 'World', year: '2010', title: 'The 10,000-bitcoin pizzas',
    story: 'On 22 May 2010 a programmer paid 10,000 bitcoins for two pizzas, the first known purchase with '
      + 'bitcoin. At later prices those coins were worth hundreds of millions of dollars.',
    takeaway: 'Hindsight makes every past decision look obvious. Judge decisions by what you knew at the time, and '
      + 'don’t let ‘what ifs’ push you into chasing the next big thing.',
  },
  {
    id: 'nyse-1914', tag: 'World', year: '1914', title: 'The four-month closure',
    story: 'When the First World War broke out, the New York Stock Exchange shut on 31 July 1914, and stock trading '
      + 'did not resume until 12 December: its longest closure ever.',
    takeaway: 'Markets can close or freeze exactly when you need cash. Keep an emergency fund in the bank, not '
      + 'in shares.',
  },
];

/** Facts about Indian tax for the tax pages; one depends on the current financial year. */
export function taxTrivia(fy) {
  return [
    {
      id: 'fy-april', tag: 'Tax', year: '1867', title: 'Why April to March?',
      story: 'India’s financial year has run from April to March since 1867, when it was aligned with the British '
        + 'government’s financial year. Before that it ran from May to April.',
      takeaway: 'Your ITR and Form 16 follow April–March, while US forms and Schedule FA use the calendar year: '
        + 'note which one a form asks for.',
    },
    {
      id: 'income-tax-1860', tag: 'Tax', year: '1860', title: 'India’s first income tax',
      story: 'Income tax came to India in 1860, introduced by James Wilson to repair the government’s finances after '
        + 'the 1857 uprising. 24 July is celebrated as Income Tax Day.',
      takeaway: 'A handy reminder: for most salaried people the ITR is due a week later, on 31 July.',
    },
    {
      id: 'new-act', tag: 'Tax', year: '2026', title: 'A new Act after 65 years',
      story: 'From 1 April 2026 the Income-tax Act, 2025 replaced the Income-tax Act, 1961. Its single ‘tax year’ '
        + 'replaces the old pair of ‘previous year’ and ‘assessment year’.',
      takeaway: 'Forms and section numbers are changing: check which Act a guide refers to before following it.',
    },
    {
      id: 'two-calendars', tag: 'Tax', title: 'Two calendars, one dividend',
      story: `The US tax year is the calendar year, while India’s runs April to March. A dividend paid in February ${
        fy.endYear} falls in US tax year ${fy.endYear} but in India’s ${fy.label}.`,
      takeaway: 'When matching a US form such as the 1042-S with your ITR, split the payments by India’s financial '
        + 'year.',
    },
    {
      id: 'fa-calendar', tag: 'Tax', title: 'Schedule FA keeps its own calendar',
      story: 'In the return for FY 2025-26, foreign assets go into Schedule FA for the calendar year January–December '
        + '2025, not for April–March.',
      takeaway: 'Shares acquired from January to March appear in the next year’s Schedule FA.',
    },
    {
      id: 'rsu-stages', tag: 'Tax', title: 'Taxed in two stages, not twice',
      story: 'An RSU is taxed in two stages in India: its value when it vests counts as salary, and any rise after '
        + 'vesting is a capital gain when you sell.',
      takeaway: 'Your cost for capital gains is the value already taxed as salary, so the same rupee is not taxed '
        + 'twice.',
    },
    {
      id: '24-months', tag: 'Tax', title: '12 months here, 24 months there',
      story: 'Shares listed in India become long-term after 12 months, but foreign shares such as US RSUs must be '
        + 'held for more than 24 months.',
      takeaway: 'Before selling foreign shares, check the 24-month date: long-term gains are taxed at 12.5% instead '
        + 'of your slab rate.',
    },
    {
      id: 'pan-letter', tag: 'Tax', title: 'What your PAN’s fourth letter says',
      story: 'The fourth character of a PAN shows who holds it: ‘P’ for an individual, ‘C’ for a company and ‘H’ for '
        + 'a Hindu undivided family.',
      takeaway: 'A quick check that you have typed the right PAN: an individual’s has a ‘P’ in fourth place.',
    },
    {
      id: 'advance-tax', tag: 'Tax', title: 'Advance tax in four steps',
      story: 'If your tax for the year after TDS is ₹10,000 or more, you pay advance tax in instalments: 15% by 15 '
        + 'June, 45% by 15 September, 75% by 15 December and all of it by 15 March.',
      takeaway: 'Foreign dividends and capital gains usually have no Indian TDS, so they often push RSU holders into '
        + 'advance tax.',
    },
    {
      id: 'w8ben', tag: 'Tax', title: '25%, not 30%',
      story: 'Under the India–US tax treaty, US tax withheld on dividends is usually 25% for Indian residents with a '
        + 'W-8BEN on file, instead of the default 30%.',
      takeaway: 'Keep the W-8BEN with your broker current: it generally lapses after about three years.',
    },
  ];
}

/** 'market', 'tax' or 'all' (market stories with a tax fact after every few). */
export function triviaPool(kind, fy) {
  const tax = taxTrivia(fy);
  if (kind === 'market') return MARKET_STORIES;
  if (kind === 'tax') return tax;
  const every = Math.max(1, Math.round(MARKET_STORIES.length / tax.length));
  const out = [];
  MARKET_STORIES.forEach((story, i) => {
    out.push(story);
    if ((i + 1) % every === 0 && tax.length) out.push(tax.shift());
  });
  return out.concat(tax);
}

/** Where the card starts: a new item each day, and a different one on each page. */
export function startIndex(length, day, seed = 0) {
  return length ? (((day + seed) % length) + length) % length : 0;
}

/** A stable number for the current page, so different pages start on different items. */
export function pageSeed(path = window.location.pathname) {
  return [...path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7);
}

const LABELS = { market: 'Another story →', tax: 'Another fact →', all: 'Next →' };

/** Render a rotating "Did you know?" card into `host`. */
export function renderTrivia(host, { seed = 0, pool = 'all' } = {}) {
  const ist = istWallClock();
  const fy = financialYear(ist);
  const items = triviaPool(pool, fy);
  if (!items.length) return;
  let i = startIndex(items.length, dayIndexOf(fy, ist.getTime()), seed);
  host.innerHTML = `
    <div class="card-head"><h2><span aria-hidden="true">💡</span> Did you know?</h2>
      <span class="spacer"></span><span class="hint trivia-count"></span></div>
    <div class="trivia-body" aria-live="polite">
      <div class="trivia-main">
        <div class="trivia-tag"></div>
        <h3 class="trivia-title"></h3>
        <p class="trivia-text"></p>
      </div>
      <p class="trivia-takeaway"><strong>Takeaway</strong><span></span></p>
    </div>
    <div class="trivia-nav">
      <button class="btn alt small" type="button" data-step="-1" aria-label="Previous">←</button>
      <button class="btn alt small" type="button" data-step="1">${LABELS[pool] || LABELS.all}</button>
    </div>`;
  const $ = (sel) => host.querySelector(sel);
  const show = () => {
    const item = items[i];
    $('.trivia-tag').textContent = item.year ? `${item.tag} · ${item.year}` : item.tag;
    $('.trivia-title').textContent = item.title;
    $('.trivia-text').textContent = item.story;
    $('.trivia-takeaway').hidden = !item.takeaway;
    $('.trivia-takeaway span').textContent = item.takeaway || '';
    $('.trivia-count').textContent = `${i + 1} / ${items.length}`;
  };
  host.querySelector('.trivia-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-step]');
    if (!btn) return;
    i = (i + Number(btn.dataset.step) + items.length) % items.length;
    show();
  });
  show();
}
