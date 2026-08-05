import TopBar from "@/components/TopBar";
import Hero from "@/components/Hero";
import WithoutWith from "@/components/WithoutWith";
import DvpFlow from "@/components/DvpFlow";
import TrustModel from "@/components/TrustModel";
import Proof from "@/components/Proof";
import Footer from "@/components/Footer";
import DeskCurtain from "@/components/DeskCurtain";

export default function Home() {
  return (
    <>
      <TopBar />
      <main className="flex-1">
        <Hero />
        <WithoutWith />
        <DvpFlow />
        <TrustModel />
        <Proof />
      </main>
      <Footer />
      <DeskCurtain />
    </>
  );
}
